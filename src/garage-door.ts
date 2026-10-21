import {
  AccessoryPlugin,
  APIEvent,
  CharacteristicEventTypes,
  CharacteristicSetCallback,
  Controller,
  Logging,
  PlatformAccessory,
  Service,
} from 'homebridge';
import { API } from 'homebridge/lib/api';
import { AccessoryConfig } from 'homebridge';
import EventSource from 'eventsource';
import { debounce } from 'lodash';
import fetch from 'node-fetch';
import Timeout = NodeJS.Timeout;

const DEBOUNCE_TIME = 500;

interface GarageDoorConfig extends AccessoryConfig {
  name: string;
  host: string;
  port: number;
  opening_time: number;
}

interface ESPHomeEvent {
  id: string;
  state: 'CLOSED' | 'OPEN';
  value: number;
  current_operation: 'IDLE' | 'OPENING' | 'CLOSING';
}

const RECONNECT_TIMEOUT = 10000;
const DEFAULT_OPEN_TIME = 30; // 30 seconds

const PING_TIME = 20 * 1000;

export class GarageDoor implements AccessoryPlugin {
  private readonly accessory: PlatformAccessory;
  private service: Service;
  espTemplateName: string;
  espTemplateId: string;
  private eventSource: EventSource;
  private initialized: boolean;
  private shuttingDown: boolean;
  private timeout: Timeout;
  private aliveTimeout: Timeout;
  private reconnectTimeout: Timeout;
  private readonly handleDoorStateDebounced = debounce(
    (e: ESPHomeEvent) => this.handleDoorState(e),
    DEBOUNCE_TIME
  );

  constructor(readonly logger: Logging, readonly config: GarageDoorConfig, readonly api: API) {
    this.accessory = new api.platformAccessory(config.name, api.hap.uuid.generate(config.name));
    this.initialized = false;
    this.shuttingDown = false;
    this.timeout = null;
    this.aliveTimeout = null;
    this.reconnectTimeout = null;
    api.on(APIEvent.DID_FINISH_LAUNCHING, () => this.connect());
    api.on(APIEvent.SHUTDOWN, () => {
      this.shuttingDown = true;
      clearTimeout(this.reconnectTimeout);
      this.closeConnection();
    });
  }

  private closeConnection() {
    clearTimeout(this.aliveTimeout);
    this.aliveTimeout = null;
    try {
      // close() also stops the built-in auto-reconnect loop of the eventsource library
      this.eventSource?.close();
    } catch (e) {
      this.logger.error(e);
    } finally {
      this.eventSource = null;
      this.initialized = false;
    }
  }

  private scheduleReconnect() {
    this.closeConnection();
    if (this.shuttingDown || this.reconnectTimeout) {
      return;
    }
    this.reconnectTimeout = setTimeout(() => {
      this.reconnectTimeout = null;
      this.connect();
    }, RECONNECT_TIMEOUT);
  }

  private resetAliveTimeout() {
    clearTimeout(this.aliveTimeout);
    this.aliveTimeout = setTimeout(() => {
      this.logger.warn(`Closing connection since no PING was received in the last ${PING_TIME}ms`);
      this.scheduleReconnect();
    }, PING_TIME); // if no ping is received in 20 seconds, we reconnect
  }

  private connect() {
    // make sure we never have more than one EventSource alive
    this.closeConnection();
    if (this.shuttingDown) {
      return;
    }
    const url = `http://${this.config.host}:${this.config.port || 80}/events`;
    let eventSource: EventSource;
    try {
      eventSource = new EventSource(url);
    } catch (e) {
      this.logger.error(e.message, e);
      this.scheduleReconnect();
      return;
    }
    this.eventSource = eventSource;
    // also covers a connection that never opens nor fails
    this.resetAliveTimeout();

    eventSource.onerror = e => {
      if (eventSource !== this.eventSource) {
        return;
      }
      this.logger.error(
        `Connection error, reconnecting in ${RECONNECT_TIMEOUT}ms...`,
        (e as any)?.message || ''
      );
      this.scheduleReconnect();
    };
    eventSource.onopen = () => {
      if (eventSource !== this.eventSource) {
        return;
      }
      this.logger.info(`Connection to ESP initialized: Event source started at ${url}`);
      this.initialized = true;
      this.resetAliveTimeout();
    };
    // listeners are registered once per EventSource, not on every (re)open
    eventSource.addEventListener('state', e => {
      try {
        const b = JSON.parse(e.data) as ESPHomeEvent;
        this.handleDoorStateDebounced(b);
      } catch (e) {
        this.logger.error('Cannot deserialize message from ESPHome', e);
      }
    });
    eventSource.addEventListener('log', e => {
      this.logger.debug(e.data);
    });
    eventSource.addEventListener('ping', () => {
      this.logger.debug('PING message');
      this.resetAliveTimeout();
    });
  }
  getControllers(): Controller[] {
    return [];
  }

  getServices(): Service[] {
    const Characteristic = this.api.hap.Characteristic;

    this.service =
      this.accessory.getService(this.api.hap.Service.GarageDoorOpener) ||
      this.accessory.addService(this.api.hap.Service.GarageDoorOpener);

    this.service
      .getCharacteristic(Characteristic.TargetDoorState)
      .on(
        CharacteristicEventTypes.SET,
        async (state: number, callback: CharacteristicSetCallback) => {
          try {
            switch (state) {
              case Characteristic.TargetDoorState.CLOSED:
                await this.handleSetState('close');
                break;
              case Characteristic.TargetDoorState.OPEN:
                await this.handleSetState('open');
                break;
              default:
                this.logger.error('Unknown action ' + state);
            }
            callback();
          } catch (e) {
            callback(e);
          }
        }
      );

    this.service
      .getCharacteristic(Characteristic.CurrentDoorState)
      .updateValue(Characteristic.CurrentDoorState.CLOSED);
    this.service
      .getCharacteristic(Characteristic.TargetDoorState)
      .updateValue(Characteristic.CurrentDoorState.CLOSED);

    const infoService =
      this.accessory.getService(this.api.hap.Service.AccessoryInformation) ||
      this.accessory.addService(this.api.hap.Service.AccessoryInformation);

    infoService
      .setCharacteristic(Characteristic.Manufacturer, 'ESPHome')
      .setCharacteristic(Characteristic.Model, 'Shelly 1')
      .setCharacteristic(Characteristic.SerialNumber, 'None')
      .setCharacteristic(Characteristic.Name, `Garage Door`);
    return [infoService, this.service];
  }

  identify(): void {}

  private async handleSetState(state: 'open' | 'close'): Promise<boolean> {
    try {
      const resp = await fetch(
        `http://${this.config.host}:${this.config.port || 80}/${this.espTemplateName}/${
          this.espTemplateId
        }/${state}`,
        {
          method: 'POST',
        }
      );
      if (this.initialized) {
        const Characteristic = this.api.hap.Characteristic;
        const isOpening = state === 'open';
        this.service.updateCharacteristic(
          Characteristic.CurrentDoorState,
          isOpening
            ? Characteristic.CurrentDoorState.OPENING
            : Characteristic.CurrentDoorState.CLOSING
        );
        if (this.timeout) {
          clearTimeout(this.timeout);
          this.timeout = null;
        }
        if (isOpening) {
          const openingTime = this.config.opening_time || DEFAULT_OPEN_TIME;
          this.timeout = setTimeout(() => {
            this.logger.debug('Timeout triggered, update door state to open');
            this.service.updateCharacteristic(
              Characteristic.CurrentDoorState,
              Characteristic.CurrentDoorState.OPEN
            );
            this.service.updateCharacteristic(
              Characteristic.TargetDoorState,
              Characteristic.TargetDoorState.OPEN
            );
            this.timeout = null;
          }, openingTime * 1000);
        }
      }
      return resp.ok;
    } catch (e) {
      this.logger.error(e);
      return false;
    }
  }

  private handleDoorState(e: ESPHomeEvent) {
    const Characteristic = this.api.hap.Characteristic;
    [this.espTemplateName, this.espTemplateId] = e.id.split('-');
    if (this.service && this.initialized) {
      this.logger.debug('GarageDoorOpener Service: updating door state', e);
      const isClosed = e.state === 'CLOSED';
      const currentStatus = isClosed
        ? Characteristic.CurrentDoorState.CLOSED
        : Characteristic.CurrentDoorState.OPEN;
      const targetStatus = isClosed
        ? Characteristic.TargetDoorState.CLOSED
        : Characteristic.TargetDoorState.OPEN;
      if (this.timeout) {
        if (isClosed) {
          // we control only the close state, since open is done through the timeout above
          this.service.updateCharacteristic(Characteristic.CurrentDoorState, currentStatus);
          this.service.updateCharacteristic(Characteristic.TargetDoorState, targetStatus);
        }
      } else {
        this.logger.debug('GarageDoorOpener Service: updating current state to ', currentStatus);
        this.logger.debug('GarageDoorOpener Service: updating target state to ', targetStatus);
        // the event is coming from an external command (a wall button or remote control) so we update the status
        // we control only the close state, since open is done through the timeout above
        this.service.updateCharacteristic(Characteristic.CurrentDoorState, currentStatus);
        this.service.updateCharacteristic(Characteristic.TargetDoorState, targetStatus);
      }
    } else {
      this.logger.warn('GarageDoorOpener Service non yet initialized');
    }
  }
}
