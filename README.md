![Logo](admin/parcel.png)
# ioBroker.parcel

[![NPM version](https://img.shields.io/npm/v/iobroker.parcel.svg)](https://www.npmjs.com/package/iobroker.parcel)
[![Downloads](https://img.shields.io/npm/dm/iobroker.parcel.svg)](https://www.npmjs.com/package/iobroker.parcel)
![Number of Installations](https://iobroker.live/badges/parcel-installed.svg)
![Current version in stable repository](https://iobroker.live/badges/parcel-stable.svg)
[![Dependency Status](https://img.shields.io/david/TA2k/iobroker.parcel.svg)](https://david-dm.org/TA2k/iobroker.parcel)

[![NPM](https://nodei.co/npm/iobroker.parcel.png?downloads=true)](https://nodei.co/npm/iobroker.parcel/)

**Tests:** ![Test and Release](https://github.com/TA2k/ioBroker.parcel/workflows/Test%20and%20Release/badge.svg)

## parcel adapter for ioBroker

Parcel tracking

## Loginablauf

DHL:
* DHL App Login eingeben
* SMS/EMail Code erhalten
* In die Instanzeinstellungen eingeben und speichern

## Amazon Vorbedingungen
Es müssen auf Linuxsysteme Pakete installiert werden

Variante #1

```sudo apt-get install -y libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm-dev libxkbcommon-dev libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm-dev```

Variante #2

``` 
sudo apt-get install -yq \
          gconf-service libasound2 libatk1.0-0 libatk-bridge2.0-0 libc6 libcairo2 libcups2 libdbus-1-3 \
          libexpat1 libfontconfig1 libgcc1 libgconf-2-4 libgdk-pixbuf2.0-0 libglib2.0-0 libgtk-3-0 libnspr4 \
          libpango-1.0-0 libpangocairo-1.0-0 libstdc++6 libx11-6 libx11-xcb1 libxcb1 libxcomposite1 libxcursor1 \
          libxdamage1 libxext6 libxfixes3 libxi6 libxrandr2 libxrender1 libxss1 libxtst6 ca-certificates \
          fonts-liberation libappindicator1 libnss3 lsb-release xdg-utils wget
 ```

Variante #3

```sudo apt-get install -y chromium```

## Diskussion und Fragen

<https://forum.iobroker.net/topic/51795/test-adapter-parcel-paketverfolgung-dhl-v0-0-1>


## Changelog

### 0.0.1
* (TA2k) initial release

## License
MIT License

Copyright (c) 2022 TA2k <tombox2020@gmail.com>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
