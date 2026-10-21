import { API } from 'homebridge';
import { GarageDoor } from './garage-door';

export default function(api: API) {
  api.registerAccessory('homebridge-esphome-garagedoor', 'GarageDoor', GarageDoor);
}
