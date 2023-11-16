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
import { Logger } from 'homebridge';
import fetch from 'node-fetch';
import Timeout = NodeJS.Timeout;

const DEBOUNCE_TIME = 500;

export function initESPHome(
  host: string,
  port = 80,
  // @ts-ignore
  logger: Logging = Logger.withPrefix('ESPHome'),
  stateListener: (state: ESPHomeEvent) => void = _state => {} // listener to events generated by ESP Home
): EventSource {
  const eventSource = new EventSource(`http://${host}:${port}/events`);
  const fn = stateListener ? debounce(e => stateListener(e), DEBOUNCE_TIME) : _e => {};

  logger.info('Event source started at ' + `http://${host}:${port}/events`);
  eventSource.addEventListener('state', e => {
    try {
      const b = JSON.parse(e.data) as ESPHomeEvent;
      fn(b);
    } catch (e) {
      logger.error('Cannot deserialize message from ESPHome', e);
    }
  });
  eventSource.addEventListener('log', e => {
    logger.debug(e.data);
  });
  return eventSource;
}

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

export class GarageDoor implements AccessoryPlugin {
  private readonly accessory: PlatformAccessory;
  private service: Service;
  espTemplateName: string;
  espTemplateId: string;
  private eventSource: EventSource;
  private initialized: boolean;
  private timeout: Timeout;
  private aliveTimeout: Timeout;

  constructor(readonly logger: Logging, readonly config: GarageDoorConfig, readonly api: API) {
    this.accessory = new api.platformAccessory(config.name, api.hap.uuid.generate(config.name));
    this.initialized = false;
    this.timeout = null;
    this.aliveTimeout = null;
    api.on(APIEvent.DID_FINISH_LAUNCHING, async () => await this.initConnection());
    api.on(APIEvent.SHUTDOWN, () => this.closeConnection());
  }

  private closeConnection() {
    try {
      this.eventSource?.close();
    } catch (e) {
      this.logger.error(e);
    } finally {
      this.initialized = false;
    }
  }

  private async initConnection(): Promise<EventSource> {
    try {
      this.eventSource = await this.connectToESPSource();
    } catch (e) {
      this.logger.error(e.message, e);
      this.eventSource = null;
      setTimeout(() => {
        this.initConnection();
      }, RECONNECT_TIMEOUT);
      return null;
    }
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

  private createTimeout(): Timeout {
    return setTimeout(async () => {
      this.closeConnection();
      await this.initConnection();
    }, 20 * 1000); // if no ping is received in 20 seconds, we reconnect
  }

  private connectToESPSource(): Promise<EventSource> {
    return new Promise((resolve, reject) => {
      try {
        const url = `http://${this.config.host}:${this.config.port}/events`;
        const eventSource = new EventSource(url);
        const fn = debounce(e => this.handleDoorState(e), DEBOUNCE_TIME);

        eventSource.onerror = async e => {
          this.logger.error('Connection error, reinitialize...', e);
          this.initialized = false;
          reject(e);
        };
        eventSource.onopen = m => {
          if (!this.initialized) {
            this.logger.info(`Connection to ESP initialized: Event source started at ${url}: ${m}`);
            this.initialized = true;
            clearTimeout(this.aliveTimeout);
            this.aliveTimeout = this.createTimeout();
            eventSource.addEventListener('state', e => {
              try {
                const b = JSON.parse(e.data) as ESPHomeEvent;
                fn(b);
              } catch (e) {
                this.logger.error('Cannot deserialize message from ESPHome', e);
              }
            });
            eventSource.addEventListener('log', e => {
              this.logger.debug(e.data);
            });
            eventSource.addEventListener('ping', () => {
              clearTimeout(this.aliveTimeout);
              this.aliveTimeout = this.createTimeout();
            });
            resolve(eventSource);
          }
        };
      } catch (e) {
        reject(e);
      }
    });
  }
}
