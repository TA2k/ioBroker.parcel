const crypto = require('crypto');
const axios = require('axios').default;
function getUuidFromUrl(url) {
  return (url = (url = url.split('/').pop()).includes('?') ? url.split('?')[0] : url), new TextEncoder().encode(url);
}
function getKeySet(keyArray) {
  return {
    secretKey: keyArray.subarray(0, 32),
    iv: keyArray.subarray(32, 44),
    aad: keyArray.subarray(44, 56),
  };
}

async function decryptAdviceWebCrypto(url) {
  await axios(url, {
    withCredentials: true,
    method: 'GET',
    responseType: 'arraybuffer',
  })
    .then(function (response) {
      if (response.status !== 200 && response.status !== 404) {
        throw new Error(`Could not fetch ${url}: ${response.status} ${response.statusText}`);
      } else {
        const uuid = getUuidFromUrl(url);
        crypto.subtle
          .digest('SHA-512', uuid)
          .then(function (hashedUuid) {
            return getKeySet(new Uint8Array(hashedUuid));
          })
          .then(function (keySet) {
            const data = response.data;
            const secretKey = keySet.secretKey;
            crypto.subtle
              .importKey('raw', secretKey, 'AES-GCM', false, ['decrypt'])
              .then(function (importedKey) {
                const decryptionParams = {
                  name: 'AES-GCM',
                  iv: keySet.iv,
                  additionalData: keySet.aad,
                };
                crypto.subtle
                  .decrypt(decryptionParams, importedKey, data)
                  .then(function (decryptedData) {
                    return URL.createObjectURL(new Blob([decryptedData]));
                  })
                  .catch(function (error) {
                    throw error;
                  });
              })
              .catch(function (error) {
                throw error;
              });
          })

          .catch(function (error) {
            throw error;
          });
      }
    })
    .catch(function (error) {
      throw error;
    });
}

module.exports = decryptAdviceWebCrypto;
