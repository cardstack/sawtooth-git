const { GITCHAIN_FAMILY, GITCHAIN_VERSION }       = require('../utils/gitchain');
const cbor                                  = require('cbor');
const preprocessors                         = require('../preprocessors');
const _                                     = require('lodash');
const request                               = require('request-promise-native');
const { pollCondition }                     = require('../utils/async');
const { Secp256k1PrivateKey } = require('sawtooth-sdk/signing/secp256k1');
const { createContext, CryptoFactory } = require('sawtooth-sdk/signing');
const { resolve } = require('url');
const { defaultConfig }       = require('../utils/config');

const { createHash } = require('crypto');
const { protobuf } = require('sawtooth-sdk');


module.exports = {
  sendTransaction,
  submitAndPoll
};


function restApiUrl(path, apiBase) {
  return resolve(apiBase, path);
}

// Expects transaction to be an object with a `type` and an `id`
async function sendTransaction({privateKey, transaction, apiBase}) {
  let preprocessor = preprocessors[transaction.type];

  if (preprocessor) {
    await preprocessor.preprocess(transaction, privateKey);
  }


  let loadedPrivateKey = Secp256k1PrivateKey.fromHex(privateKey);
  let context = createContext('secp256k1');
  let signer = new CryptoFactory(context).newSigner(loadedPrivateKey);

  let payloadBytes = cbor.encode(transaction);

  const transactionHeaderBytes = protobuf.TransactionHeader.encode({
    familyName: GITCHAIN_FAMILY,
    familyVersion: GITCHAIN_VERSION,
    inputs: (_.get(transaction, 'meta.inputs')  || []),
    outputs: (_.get(transaction, 'meta.outputs') || []),
    signerPublicKey: signer.getPublicKey().asHex(),
    batcherPublicKey: signer.getPublicKey().asHex(),
    dependencies: [],
    payloadSha512: createHash('sha512').update(payloadBytes).digest('hex')
  }).finish();

  let signature = signer.sign(transactionHeaderBytes);

  let sawtoothTransaction = protobuf.Transaction.create({
    header: transactionHeaderBytes,
    headerSignature: signature,
    payload: payloadBytes
  });

  let transactions = [sawtoothTransaction];

  let batchHeaderBytes = protobuf.BatchHeader.encode({
    signerPublicKey: signer.getPublicKey().asHex(),
    transactionIds: transactions.map((txn) => txn.headerSignature),
  }).finish();

  let batchSignature = signer.sign(batchHeaderBytes);

  const batch = protobuf.Batch.create({
    header: batchHeaderBytes,
    headerSignature: batchSignature,
    transactions: transactions
  });

  let body = protobuf.BatchList.encode({
    batches: [batch]
  }).finish();

  return JSON.parse(await request.post({
    url:      restApiUrl('batches', defaultConfig('GITCHAIN_REST_ENDPOINT', apiBase)),
    headers:  {'Content-Type': 'application/octet-stream'},
    body
  }));
}


async function pollBatch(batchStatusUrl) {
  let batchStatus;
  await pollCondition(async () => {
    batchStatus = await request(batchStatusUrl, {json: true});
    return batchStatus.data[0].status === "COMMITTED";
  });
  return batchStatus.data[0].id;
}

async function getBatchData(batchStatusUrl, apiBase) {
  let batchId = await pollBatch(batchStatusUrl);
  return await request(restApiUrl(`batches/${batchId}`, defaultConfig('GITCHAIN_REST_ENDPOINT', apiBase)), {json: true});
}

async function submitAndPoll(options) {
  let result = await sendTransaction(options);
  return await getBatchData(result.link);
}
