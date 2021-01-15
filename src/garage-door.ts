import {
  AccessoryPlugin,
  Controller,
  PlatformAccessory,
  Service,
  Logging,
  CharacteristicEventTypes,
  CharacteristicSetCallback,
  APIEvent,
} from 'homebridge';
import { API } from 'homebridge/lib/api';
import { AccessoryConfig } from 'homebridge/lib/server';
import EventSource from 'eventsource';
import { debounce } from 'lodash';
import { withPrefix } from 'homebridge/lib/logger';
import fetch from 'node-fetch';

const DEBOUNCE_TIME = 500;

export function initESPHome(
  host: string,
  port = 80,
  logger: Logging = withPrefix('ESPHome'),
  listener: (e: ESPHomeEvent) => void = _e => {}
): EventSource {
  const eventSource = new EventSource(`http://${host}:${port}/events`);
  const fn = listener ? debounce(e => listener(e), DEBOUNCE_TIME) : _e => {};

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
}

interface ESPHomeEvent {
  id: string;
  state: 'CLOSED' | 'OPEN';
  value: number;
  current_operation: 'IDLE' | 'OPENING' | 'CLOSING';
}

const MAX_RETRY = 5;

export class GarageDoor implements AccessoryPlugin {
  private readonly accessory: PlatformAccessory;
  private service: Service;
  espTemplateName: string;
  espTemplateId: string;
  private eventSource: EventSource;

  constructor(readonly logger: Logging, readonly config: GarageDoorConfig, readonly api: API) {
    this.accessory = new api.platformAccessory(config.name, api.hap.uuid.generate(config.name));
    api.on(APIEvent.DID_FINISH_LAUNCHING, async () => {
      for (let i = 0; i < MAX_RETRY; i++) {
        try {
          await this.connectToESPSource();
        } catch (e) {
          logger.error(e.toString(), e);
        }
      }
    });
    api.on(APIEvent.SHUTDOWN, () => {
      try {
        this.eventSource?.close();
      } catch (e) {
        logger.error(e);
      }
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

  private async handleSetState(state: string): Promise<boolean> {
    try {
      const resp = await fetch(
        `http://${this.config.host}:${this.config.port || 80}/${this.espTemplateName}/${
          this.espTemplateId
        }/${state}`,
        {
          method: 'POST',
        }
      );
      return resp.ok;
    } catch (e) {
      this.logger.error(e);
      return false;
    }
  }

  private handleDoorState(e: ESPHomeEvent) {
    const Characteristic = this.api.hap.Characteristic;
    [this.espTemplateName, this.espTemplateId] = e.id.split('-');
    if (this.service) {
      this.logger.debug('GarageDoorOpener Service: updating door state', e);
      this.service.updateCharacteristic(
        Characteristic.CurrentDoorState,
        e.state === 'CLOSED'
          ? Characteristic.CurrentDoorState.CLOSED
          : Characteristic.CurrentDoorState.OPEN
      );
      this.service.updateCharacteristic(
        Characteristic.TargetDoorState,
        e.state === 'CLOSED'
          ? Characteristic.CurrentDoorState.CLOSED
          : Characteristic.CurrentDoorState.OPEN
      );
    } else {
      this.logger.warn('GarageDoorOpener Service non yet initialized');
    }
  }

  private connectToESPSource() {
    return new Promise((resolve, reject) => {
      this.eventSource = initESPHome(this.config.host, this.config.port, this.logger, e =>
        this.handleDoorState(e)
      );
      this.eventSource.onerror = e => {
        this.logger.error('Connection error, reinitialize...', e);
        reject(e);
      };
      this.eventSource.onopen = m => {
        this.logger.error('Connection initialized...', m);
        resolve(m);
      };
    });
  }
}
