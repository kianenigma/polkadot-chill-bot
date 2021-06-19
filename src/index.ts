import { ApiPromise, Keyring, WsProvider } from "@polkadot/api";
import { hideBin } from "yargs/helpers"
import { AccountId, CodecHash } from "@polkadot/types/interfaces/runtime"
import { EventRecord } from "@polkadot/types/interfaces/"
import { SubmittableExtrinsic } from "@polkadot/api/submittable/types"
import { ISubmittableResult } from "@polkadot/types/types/"
import BN from "bn.js";
import { readFileSync, statSync } from "fs";
import yargs from 'yargs';
import { KeyringPair } from "@polkadot/keyring/types"

const optionsPromise = yargs(hideBin(process.argv))
	.option('endpoint', {
		alias: 'e',
		type: 'string',
		description: 'the wss endpoint. It must allow unsafe RPCs.',
		required: true,
	})
	.option('count', {
		alias: 'c',
		type: 'number',
		description: 'number of accounts to chill',
	})
	.option('no-dry-run', {
		type: 'boolean',
		description: 'do not dry-run the command first. Advised not to set. Only set if you do not have access to local node with this RPC',
	})
	.option('seed', {
		alias: 's',
		type: 'string',
		description: 'path to a raw text file that contains your raw or mnemonic seed.',
		required: true,
	})
	.argv

async function main() {
	const options = await optionsPromise;
	const provider = new WsProvider(options.endpoint);
	const api = await ApiPromise.create({ provider });
	const keyring = new Keyring({ type: 'sr25519', ss58Format: api.registry.chainSS58 });
	console.log(`Connected to node: ${(await api.rpc.system.chain()).toHuman()} [${options.endpoint} - ss58: ${api.registry.chainSS58}]`);

	const threshold = api.createType('Balance', (await api.query.staking.minNominatorBond())).toBn();
	const limit = options.count;
	const seed = readFileSync(options.seed).toString().trim();
	const account = keyring.addFromUri(seed);
	console.log(`📣 using account ${account.address}, info ${await api.query.system.account(account.address)}`)
	console.log(`📣 threshold for chilling is ${api.createType('Balance', threshold).toHuman()}`);

	const transactions = await buildChillTxs(api, threshold, limit)
	const batch = api.tx.utility.batch(transactions);

	if (options['no-dry-run']) {
		const { success, included } = await sendAndFinalize(batch, account);
		console.log(`ℹ️ success = ${success}. Events = ${included}`)
	} else {
		const success = await dryRun(api, account, batch);
		if (success) {
			const { success, included } = await sendAndFinalize(batch, account);
			console.log(`ℹ️ success = ${success}. Events = ${included}`)
		} else {
			console.log(`warn: dy-run failed. not submitting anything.`)
		}
	}
}

interface ISubmitResult {
	hash: CodecHash,
	success: boolean,
	included: EventRecord[],
	finalized: EventRecord[],
}

async function sendAndFinalize(tx: SubmittableExtrinsic<"promise", ISubmittableResult>, account: KeyringPair): Promise<ISubmitResult> {
	return new Promise(async resolve => {
		let success = false;
		let included: EventRecord[] = []
		let finalized: EventRecord[] = []
		const unsubscribe = await tx.signAndSend(account, ({ events = [], status, dispatchError }) => {
			if (status.isInBlock) {
				success = dispatchError ? false : true;
				console.log(`📀 Transaction ${tx.meta.name}(${tx.args.toString()}) included at blockHash ${status.asInBlock} [success = ${success}]`);
				included = [...events]
			} else if (status.isBroadcast) {
				console.log(`🚀 Transaction broadcasted.`);
			} else if (status.isFinalized) {
				console.log(`💯 Transaction ${tx.meta.name}(..) Finalized at blockHash ${status.asFinalized}`);
				finalized = [...events]
				const hash = status.hash;
				unsubscribe();
				resolve({ success, hash, included, finalized })
			} else if (status.isReady) {
				// let's not be too noisy..
			} else {
				console.log(`🤷 Other status ${status}`)
			}
		})
	})
}

async function dryRun(api: ApiPromise, account: KeyringPair, batch: SubmittableExtrinsic<"promise", ISubmittableResult>): Promise<boolean> {
	const signed = await batch.signAsync(account);
	const dryRun = await api.rpc.system.dryRun(signed.toHex());
	console.log(`dry_run of ${batch.toHuman()} => ${dryRun}`)
	return dryRun.isOk && dryRun.asOk.isOk

}

async function buildChillTxs(api: ApiPromise, threshold: BN, maybeLimit?: number): Promise<SubmittableExtrinsic<"promise", ISubmittableResult>[]> {
	const allNominatorEntries = (await api.query.staking.nominators.entries()).map(async ([stashKey, _]) => {
		const stash = api.createType('AccountId', stashKey.slice(-32));
		// all nominators should have a stash and ledger; qed.
		const ctrl = (await api.query.staking.bonded(stash)).unwrap()
		const stake = (await api.query.staking.ledger(ctrl)).unwrapOrDefault().total.toBn();
		return { ctrl, stake }
	});
	const allNominators = await Promise.all(allNominatorEntries);

	// sort
	allNominators.sort((n1, n2) => n1.stake.cmp(n2.stake));
	// filter those that are below
	const toRemoveAll = allNominators.filter((n) => n.stake.lt(threshold));
	// take some, or all
	const toRemoveFinal = maybeLimit === null ? toRemoveAll : toRemoveAll.slice(0, maybeLimit);

	return toRemoveFinal.map(({ ctrl, stake}) => {
		console.log(`will chill ${ctrl.toHuman()} with stake ${api.createType('Balance', stake).toHuman()}`);
		return api.tx.staking.chill_other(ctrl);
	});
}

main().catch(console.error).finally(() => process.exit());

