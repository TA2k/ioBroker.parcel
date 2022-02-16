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


## Skripte

### Telegram Benachrichtigung bei Statusänderung  via Javascript Skript:

```
const alreadySentMessages = {}
on({ id: "parcel.0.allProviderObjects", change: "ne" }, function (obj) {
    const sendungen = JSON.parse(obj.state.val)
    const ids = Object.keys(sendungen)
    for (const id of ids) {
        if (alreadySentMessages[id] === sendungen[id].status) {
            return
        }
        sendTo('telegram.0', sendungen[id].name + '\n' + sendungen[id].status);
        alreadySentMessages[id] = sendungen[id].status
    }
});
```

### DHL Briefverfolgung Telegram versenden via Javascript Skript:

```
const alreadySent = {}
const fs = require('fs')
on({id:/^parcel\.0\.dhl\.briefe.*image$/, change: "ne"}, async function(obj){

    const parentId = obj.id.split(".")
    parentId.splice(-1)
    parentId.push("image_url")
    const urlState = await getStateAsync(parentId.join("."))

    if (alreadySent[urlState.val]) {
        return
    }
    const base64Data = obj.state.val.split("base64,")[1]
    fs.writeFile("/tmp/snapshot.jpg", base64Data, 'base64', function(err) {
      if (err) {
        console.error(err);
      } else {
        sendTo('telegram.0', 'Briefankündigung');
        sendTo('telegram.0', '/tmp/snapshot.jpg');
        alreadySent[urlState.val] = true
      }
    });
});
 

```

### DHL Briefverfolgung in der Vis anzeigen.

Den Datenpunkt image ein "String img src" element als Object ID zuordnen

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
