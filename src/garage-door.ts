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
import { AccessoryConfig } from 'homebridge/lib/server';
import EventSource from 'eventsource';
import { debounce } from 'lodash';
import { withPrefix } from 'homebridge/lib/logger';
import fetch from 'node-fetch';
import Timeout = NodeJS.Timeout;
import retry from 'async-retry';

const DEBOUNCE_TIME = 500;

export function initESPHome(
  host: string,
  port = 80,
  logger: Logging = withPrefix('ESPHome'),
  stateListener: (state: ESPHomeEvent) => void = _state => {}
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

const MAX_RETRY = 5;
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
      return await retry(() => this.connectToESPSource(), {
        retries: MAX_RETRY,
        minTimeout: 5000,
        maxTimeout: 5000,

        onRetry: () => this.logger.info('Retrying connect to hardware'),
      });
    } catch (e) {
      this.logger.info(`error: ${e.message}`, e);
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
        this.service.updateCharacteristic(
          Characteristic.CurrentDoorState,
          state === 'open'
            ? Characteristic.CurrentDoorState.OPENING
            : Characteristic.CurrentDoorState.CLOSING
        );
        if (this.timeout) {
          clearTimeout(this.timeout);
          this.timeout = null;
        }
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
      if (isClosed) {
        // we control only the close state, since open is done through the timeout above
        this.service.updateCharacteristic(
          Characteristic.CurrentDoorState,
          Characteristic.CurrentDoorState.CLOSED
        );
        this.service.updateCharacteristic(
          Characteristic.TargetDoorState,
          Characteristic.TargetDoorState.CLOSED
        );
      }
    } else {
      this.logger.warn('GarageDoorOpener Service non yet initialized');
    }
  }

  private connectToESPSource(): Promise<EventSource> {
    return new Promise((resolve, reject) => {
      try {
        const eventSource = initESPHome(this.config.host, this.config.port, this.logger, state =>
          this.handleDoorState(state)
        );
        eventSource.onerror = async e => {
          this.logger.error('Connection error, reinitialize...', e);
          this.closeConnection();
          await this.initConnection();
        };
        eventSource.onopen = m => {
          if (!this.initialized) {
            this.logger.info('Connection to ESP initialized...', m);
            this.initialized = true;
            resolve(eventSource);
          }
        };
        eventSource.addEventListener('ping', () => {
          this.aliveTimeout.refresh();
        });
        this.aliveTimeout = setTimeout(async () => {
          this.closeConnection();
          await this.initConnection();
        }, 20 * 1000); // if no ping is received in 20 seconds, we reconnect
      } catch (e) {
        reject(e);
      }
    });
  }
}
