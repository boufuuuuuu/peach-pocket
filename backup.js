/* Encrypted backups for Peach Pocket. No network, no dependencies. */
(function(root, factory) {
  const mod = factory();
  if (typeof module === 'object' && module.exports) module.exports = mod;
  else root.PeachBackup = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const FORMAT = 'peach-pocket-encrypted-v1';
  const AAD = new TextEncoder().encode('Peach Pocket | encrypted backup | v1');
  const toBytes = value => new TextEncoder().encode(value);
  const cryptoAPI = () => {
    const c = globalThis.crypto;
    if (!c?.subtle || !c.getRandomValues) throw Error('この端末では暗号化を利用できません（HTTPSが必要です）');
    return c;
  };
  const b64 = bytes => {
    let out = '';
    for (let i = 0; i < bytes.length; i += 8192) {
      out += String.fromCharCode(...bytes.subarray(i, i+8192));
    }
    return btoa(out);
  };
  const unb64 = value => Uint8Array.from(atob(value), x => x.charCodeAt(0));
  const passOK = password => typeof password==='string' && password.length >= 12 && password.length <= 256;
  async function derive(password, salt, use) {
    const c = cryptoAPI();
    const key = await c.subtle.importKey('raw', toBytes(password), 'PBKDF2', false, ['deriveKey']);
    return c.subtle.deriveKey({name:'PBKDF2',hash:'SHA-256',salt,iterations:310000},key,{name:'AES-GCM',length:256},false,[use]);
  }
  async function encrypt(data, password) {
    if (!passOK(password)) throw Error('合言葉は12〜256文字で設定してください');
    const c=cryptoAPI(), salt=c.getRandomValues(new Uint8Array(16)),iv=c.getRandomValues(new Uint8Array(12));
    const key=await derive(password,salt,'encrypt');
    const plaintext=toBytes(JSON.stringify(data));
    if (plaintext.length>12*1024*1024) throw Error('バックアップの容量上限は12MBです');
    const ciphertext=new Uint8Array(await c.subtle.encrypt({name:'AES-GCM',iv,additionalData:AAD},key,plaintext));
    return {format:FORMAT,kdf:'PBKDF2-SHA256',iterations:310000,algorithm:'AES-256-GCM',salt:b64(salt),iv:b64(iv),data:b64(ciphertext)};
  }
  function isEncrypted(value) {return value?.format===FORMAT;}
  async function decrypt(payload,password) {
    if (!isEncrypted(payload)) throw Error('暗号化バックアップの形式が違います');
    if (!passOK(password)) throw Error('バックアップ作成時の合言葉を入力してください');
    if (payload.kdf!=='PBKDF2-SHA256'||payload.iterations!==310000||payload.algorithm!=='AES-256-GCM') throw Error('暗号化バックアップの方式が非対応です');
    for (const field of ['salt','iv','data']) if (typeof payload[field]!=='string') throw Error('暗号化バックアップが壊れています');
    if (payload.data.length>20*1024*1024) throw Error('バックアップの容量が大きすぎます');
    let salt, iv, data;
    try {salt=unb64(payload.salt);iv=unb64(payload.iv);data=unb64(payload.data);} catch {throw Error('暗号化バックアップが壊れています');}
    if (salt.length!==16||iv.length!==12||data.length<16) throw Error('暗号化バックアップが壊れています');
    try {
      const key=await derive(password,salt,'decrypt');
      const plaintext=await cryptoAPI().subtle.decrypt({name:'AES-GCM',iv,additionalData:AAD},key,data);
      const dataJSON=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(plaintext));
      if (!Array.isArray(dataJSON?.items) || dataJSON.items.length>10000) throw Error('作品一覧が不正です');
      return dataJSON;
    } catch (e) {if (e.message==='作品一覧が不正です')throw e;throw Error('合言葉が違うか、バックアップが破損しています');}
  }
  return {FORMAT,encrypt,decrypt,isEncrypted,passOK};
});
