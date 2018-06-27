let BITBOXCli = require('bitbox-cli/lib/bitbox-cli').default;
let BITBOX = new BITBOXCli();

let Utils = require('./utils')

module.exports = class Core {
	
	static mineForSecretNumber(){
		var secret = BITBOX.Crypto.randomBytes(32);

		while(!(secret.readInt32LE() <= 1073741824 && secret.readInt32LE() >= -1073741824)){
			secret = BITBOX.Crypto.randomBytes(32);
		}

		return secret;
	}

	static async sendRawTransaction(hex, retries=20) {
		var result;

		var i = 0;

		while(result == undefined){
			result = await BITBOX.RawTransactions.sendRawTransaction(hex);
			i++;
			if (i > retries)
				throw new Error("BITBOX.RawTransactions.sendRawTransaction endpoint experienced a problem.")
			await Utils.sleep(2000);
		}

		if(result.length != 64)
			console.log("An error occured while sending the transaction:\n" + result);

		return result;
	}

	static async getAddressDetailsWithRetry(address, retries=20){
		var result;
		var count = 0;

		while(result == undefined){
			result = await BITBOX.Address.details(address);
			count++;
			if(count > retries)
				throw new Error("BITBOX.Address.details endpoint experienced a problem");

			await Utils.sleep(2000);
		}

		return result;
	}

	static async getUtxoWithRetry(address, retries=20){
		var result;
		var count = 0;

		while(result == undefined){
			result = await Core.getUtxo(address)
			count++;
			if(count > retries)
				throw new Error("BITBOX.Address.utxo endpoint experienced a problem");
			await Utils.sleep(2000);
		}

		return result;
	}

	static async getUtxo(address) {
		return new Promise( (resolve, reject) => {
			BITBOX.Address.utxo(address).then((result) => { 
				resolve(result)
			}, (err) => { 
				console.log(err)
				reject(err)
			})
		})
	}

	static purseAmount(betAmount){
		let byteCount = BITBOX.BitcoinCash.getByteCount({ P2PKH: 1 }, { P2SH: 1 });
		return (betAmount * 2 ) - byteCount - 750;
	}

	static async checkSufficientBalance(address) {
		let addrDetails = await Core.getAddressDetailsWithRetry(address);
		
		if (addrDetails.unconfirmedBalanceSat <= 0 && addrDetails.balanceSat == 0) {
			console.log("The address provided has a zero balance... please add funds to this address.");
			return false;
		}

		console.log("confirmed balance (sat): " + addrDetails.balanceSat);
		console.log("unconfirmed balance (sat): " + addrDetails.unconfirmedBalanceSat);
		return true;

	}
	
	static async getConfirmedAndUnconfirmedAddressBalance(address){
		let addrDetails = await Core.getAddressDetailsWithRetry(address);
		let total = addrDetails.balanceSat + addrDetails.unconfirmedBalanceSat;
		return total;
	}

	static decodePhaseData(buf, networkByte=0x00) {

		// convert op_return buffer to hex string
		//op_return = op_return.toString('hex');

		// split the op_return payload and get relavant data
		//let data = op_return.split("04004245544c"); // pushdata (0x04) + Terab ID + pushdata (0x4c)
		//let buf = Buffer.from(data[0].trim(), 'hex');  // NOTE: the index of data was changed to 0 due to MessageFeed listen method.

		// grab the common fields
		let version = buf[0];
		let phase = buf[1];
		let results = { version: version, phase: phase };

		// Phase 1 specific fields
		if(phase === 0x01) {
			// Bet Type
			results.type = buf[2];
			// Bet Amount
			results.amount = parseInt(buf.slice(3,11).toString('hex'), 16);
			// Host commitment
			results.hostCommitment = buf.slice(11,31);

			// Target address (as hash160 without network or sha256)
			if (buf.length > 31){ 
				var pkHash160Hex = buf.slice(31).toString('Hex');
				results.address = Utils.hash160_2_cashAddr(pkHash160Hex, networkByte);
			}
		// Phase 2 specific fields
		} else if(phase === 0x02) {
			// Bet Txn Id
			results.betTxId = buf.slice(2, 34);
			// 33 byte Multi-sig Pub Key
			results.multisigPubKey = buf.slice(34,67);
			// 20 byte bob commitment
			results.secretCommitment = buf.slice(67);

		// Phase 3  specific fields
		} else if(phase === 0x03) {
			// 32 byte Bet Txn Id
			results.betTxId = buf.slice(2, 34);
			// 32 byte Participant Txn Id
			results.participantOpReturnTxId = buf.slice(34, 66);
			// 32 byte Host P2SH txid
			results.hostP2SHTxId = buf.slice(66, 98);
			// 33 byte Host (Alice) multsig pubkey
			results.hostMultisigPubKey = buf.slice(98);

		//Phase 4 specific fields
		} else if(phase === 0x04) {
			// 32 byte Bet Txn Id
			results.betTxId = buf.slice(2, 34);
			// 32 byte Participant Txn Id
			results.participantP2SHTxId = buf.slice(34, 66);
			// 72 byte Participant Signature 1
			results.participantSig1 = buf.slice(66, 138);
			// 72 byte Participant Signature 2
			results.participantSig2 = buf.slice(138);

		// Phase 6 specific fields
		} else if(phase === 0x06) {
			// 32 byte Bet Txn Id
			results.betTxId = buf.slice(2, 34)
			// 32 byte Secret Value
			results.secretValue = buf.slice(34, 66);
		}

		return results;
	}

	static async createOP_RETURN(wallet, op_return_buf) {
		
		// THIS MAY BE BUGGY TO HAVE THIS HERE
		//wallet.utxo = await this.getUtxo(wallet.address);
		
		//return new Promise((resolve, reject) => {
		let transactionBuilder = new BITBOX.TransactionBuilder('bitcoincash');
		let hashType = transactionBuilder.hashTypes.SIGHASH_ALL;

		let totalUtxo = 0;
		wallet.utxo.forEach((item, index) => { 
			transactionBuilder.addInput(item.txid, item.vout); 
			totalUtxo += item.satoshis;
		});

		let byteCount = BITBOX.BitcoinCash.getByteCount({ P2PKH: wallet.utxo.length }, { P2SH: 0 }) + op_return_buf.length + 100;
		let satoshisAfterFee = totalUtxo - byteCount

		transactionBuilder.addOutput(op_return_buf, 0);        				        // OP_RETURN Message 
		transactionBuilder.addOutput(BITBOX.Address.toLegacyAddress(wallet.utxo[0].cashAddress), satoshisAfterFee); // Change 
		//console.log("txn fee: " + byteCount);
		//console.log("satoshis left: " + satoshisAfterFee);
		let key = BITBOX.ECPair.fromWIF(wallet.wif);

		let redeemScript;
		wallet.utxo.forEach((item, index) => {
			transactionBuilder.sign(index, key, redeemScript, hashType, item.satoshis);
		});

		let hex = transactionBuilder.build().toHex();

		//console.log("Create op_return message hex:", hex);

		let txId = await Core.sendRawTransaction(hex);
		return txId;
	}

	static async createEscrow(wallet, script, betAmount){
		
		//return new Promise( (resolve, reject) => {
		let transactionBuilder = new BITBOX.TransactionBuilder('bitcoincash');
		let hashType = transactionBuilder.hashTypes.SIGHASH_ALL | transactionBuilder.hashTypes.SIGHASH_ANYONECANPAY;

		let totalUtxo = 0;
		wallet.utxo.forEach((item, index) => { 
			transactionBuilder.addInput(item.txid, item.vout); 
			totalUtxo += item.satoshis;
		});

		let byteCount = BITBOX.BitcoinCash.getByteCount({ P2PKH: wallet.utxo.length }, { P2SH: 1 }) + 50;
		let satoshisAfterFee = totalUtxo - byteCount - betAmount

		let p2sh_hash160 = BITBOX.Crypto.hash160(script);
		let p2sh_hash160_hex = p2sh_hash160.toString('hex');
		let scriptPubKey = BITBOX.Script.scriptHash.output.encode(p2sh_hash160);

		let escrowAddress = BITBOX.Address.toLegacyAddress(BITBOX.Address.fromOutputScript(scriptPubKey));
		let changeAddress = BITBOX.Address.toLegacyAddress(wallet.utxo[0].cashAddress);
		// console.log("escrow address: " + address);
		// console.log("change satoshi: " + satoshisAfterFee);
		// console.log("change bet amount: " + betAmount);

		transactionBuilder.addOutput(escrowAddress, betAmount);
		transactionBuilder.addOutput(changeAddress, satoshisAfterFee);
		//console.log("Added escrow outputs...");

		let key = BITBOX.ECPair.fromWIF(wallet.wif);

		let redeemScript;
		wallet.utxo.forEach((item, index) => {
			transactionBuilder.sign(index, key, redeemScript, hashType, item.satoshis);
		});
		//console.log("signed escrow inputs...");

		let hex = transactionBuilder.build().toHex();
		//console.log("built escrow...");

		let txId = await Core.sendRawTransaction(hex);
		return txId;
    }
    
    static async redeemEscrowToEscape(wallet, redeemScript, txid, betAmount){
        
        //return new Promise( (resolve, reject) => {
    
		let hostKey = BITBOX.ECPair.fromWIF(wallet.wif)
		let participantKey = BITBOX.ECPair.fromWIF(client.wif)
		let transactionBuilder = new BITBOX.TransactionBuilder('bitcoincash');

		let hashType = 0xc1 // transactionBuilder.hashTypes.SIGHASH_ANYONECANPAY | transactionBuilder.hashTypes.SIGHASH_ALL
		let byteCount = BITBOX.BitcoinCash.getByteCount({ P2PKH: 1 }, { P2SH: 1 });
		let satoshisAfterFee = betAmount - byteCount - 350;
		// NOTE: must set the Sequence number below
		transactionBuilder.addInput(txid, 0, bip68.encode({ blocks: 1 })); // No need to worry about sweeping the P2SH address.      
		transactionBuilder.addOutput(BITBOX.Address.toLegacyAddress(wallet.utxo[0].cashAddress), satoshisAfterFee);

		let tx = transactionBuilder.transaction.buildIncomplete();

		let signatureHash = tx.hashForWitnessV0(0, redeemScript, betAmount, hashType);
		let hostSignature = hostKey.sign(signatureHash).toScriptSignature(hashType);
		let participantSignature = participantKey.sign(signatureHash).toScriptSignature(hashType);

		let redeemScriptSig = []; // start by pushing with true for makeBet mode

		// host signature
		redeemScriptSig.push(hostSignature.length);
		hostSignature.forEach((item, index) => { redeemScriptSig.push(item); });

		// push mode onto stack for MakeBet mode
		redeemScriptSig.push(0x00); //use 0 for escape mode

		if (redeemScript.length > 75) redeemScriptSig.push(0x4c);
		redeemScriptSig.push(redeemScript.length);
		redeemScript.forEach((item, index) => { redeemScriptSig.push(item); });
		
		redeemScriptSig = Buffer(redeemScriptSig);
		
		let redeemScriptSigHex = redeemScriptSig.toString('hex');
		let redeemScriptHex = redeemScript.toString('hex');
		
		tx.setInputScript(0, redeemScriptSig);
		let hex = tx.toHex();
		
		let txId = await Core.sendRawTransaction(hex);
		return txId;
	}
}