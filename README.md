# homebridge-esphome-garagedoor

A simple [HomeBridge](https://github.com/homebridge/homebridge) plugin to make your
garage door smart using a [Shelly 1](https://shelly.cloud/products/shelly-1-smart-home-automation-relay/) and [ESPHome](https://esphome.io/). Based on [this](https://savjee.be/2020/06/make-garage-door-opener-smart-shelly-esphome-home-assistant/) project.

## Setup

You need a [Shelly 1](https://shelly.cloud/products/shelly-1-smart-home-automation-relay/) and [ESPHome](https://esphome.io/) environment to get started. Please follow the blog post linked above to get a working firmware for your Shelly.
Once you are able to open and close your garage through the ESPHome WEB UI, you can install this plugin.

Add this configuration to your homebrige config.json file:

```json
{
  "accessories": [
    {
      "name": "homebridge-esphome-garagedoor",
      "accessory": "GarageDoor",
      "host": "garagedoor.local",
      "port": 80
    }
  ]
}
```

Restart homebridge and enjoy the new garage door opener in HomeKit.

## Limitations

The plugin is not able to expose `OPENING` or `CLOSING` statue to HomeKit, since we would need two contact sensors for that, but Shelly 1 only has one. It would be possible to use GPIO3, but ESPHome doesn't map it.

## Build from sources

To build and run the plugin from sources, you need to install [yarn](https://yarnpkg.com) first.

Clone the repo:

    git clone git@github.com:madchicken/homebridge-esphome-garagedoor.git

Once you get it, run yarn command:

    cd homebridge-esphome-garagedoor
    yarn && yarn build

You should end up with a new `dist/` folder containing the compiled version of the plugin.

## License

Licensed under [Apache 2.0](LICENSE)

## Contribute

Any PR is welcome to this project, so please, fork and open one if you can!

If otherwise, you simply enjoyed using this plugin, and you want to contribute in some way, you can always donate something!

[![Donate](https://img.shields.io/badge/Donate-PayPal-green.svg)](paypal.me/madchicken74)
