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

async function decryptAdviceWebCrypto(url, requestClient) {
  const decryptImage = await requestClient(url, {
    withCredentials: true,
    method: 'GET',
    responseType: 'arraybuffer',
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Linux; Android 10; SM-G975F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.120 Mobile Safari/537.36',
    },
  })
    .then(async function (response) {
      const uuid = getUuidFromUrl(url);
      return await crypto.subtle
        .digest('SHA-512', uuid)
        .then(function (hashedUuid) {
          return getKeySet(new Uint8Array(hashedUuid));
        })
        .then(async function (keySet) {
          const data = response.data;
          const secretKey = keySet.secretKey;
          return await crypto.subtle
            .importKey('raw', secretKey, 'AES-GCM', false, ['decrypt'])
            .then(async function (importedKey) {
              const decryptionParams = {
                name: 'AES-GCM',
                iv: keySet.iv,
                additionalData: keySet.aad,
              };
              return await crypto.subtle
                .decrypt(decryptionParams, importedKey, data)
                .then(function (decryptedData) {
                  return decryptedData;
                  // return URL.createObjectURL(new Blob([decryptedData]));
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
    })
    .catch(function (error) {
      throw error;
    });
  return decryptImage;
}

module.exports = decryptAdviceWebCrypto;
