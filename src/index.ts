import { ApiPromise, Keyring, WsProvider } from "@polkadot/api";
import { hideBin } from "yargs/helpers"
import { CodecHash } from "@polkadot/types/interfaces/runtime"
import { EventRecord } from "@polkadot/types/interfaces/"
import { SubmittableExtrinsic } from "@polkadot/api/submittable/types"
import { ISubmittableResult } from "@polkadot/types/types/"
import BN from "bn.js";
import { readFileSync } from "fs";
import yargs, { argv } from 'yargs';
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

	await kick(api, keyring, options.seed, options['no-dry-run'], options.count)
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
				console.log(`📀 Transaction ${tx.meta.name}(..) included at blockHash ${status.asInBlock} [success = ${success}]`);
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

async function kick(api: ApiPromise, keyring: Keyring, seedPath: string, noDryRun?: boolean, limit?: number) {
	const threshold = api.createType('Balance', (await api.query.staking.minNominatorBond())).toBn();
	const seed = readFileSync(seedPath).toString().trim();
	const account = keyring.addFromUri(seed);
	console.log(`📣 using account ${account.address}, info ${await api.query.system.account(account.address)}`)
	console.log(`📣 threshold for chilling is ${api.createType('Balance', threshold).toHuman()}`);

	const transactions = await buildChillTxs(api, threshold, limit)
	const batch = api.tx.utility.batchAll(transactions);

	if (noDryRun) {
		const { success, included } = await sendAndFinalize(batch, account);
		console.log(`ℹ️ success = ${success}. Events = ${included}`)
	} else {
		const success = await dryRun(api, account, batch);
		if (success) {
			const { success, included } = await sendAndFinalize(batch, account);
			console.log(`ℹ️ success = ${success}. Events =`)
			for (const ev of included) {
				process.stdout.write(`${ev.event.section}::${ev.event.method}`)
			}
		} else {
			console.log(`warn: dy-run failed. not submitting anything.`)
		}
	}
}

async function dryRun(api: ApiPromise, account: KeyringPair, batch: SubmittableExtrinsic<"promise", ISubmittableResult>): Promise<boolean> {
	const signed = await batch.signAsync(account);
	const dryRun = await api.rpc.system.dryRun(signed.toHex());
	console.log(`dry run of transaction => ${dryRun.toHuman()}`)
	return dryRun.isOk && dryRun.asOk.isOk
}

async function buildChillTxs(api: ApiPromise, threshold: BN, maybeLimit?: number): Promise<SubmittableExtrinsic<"promise", ISubmittableResult>[]> {
	let allVotes = 0;
	const AllNominatorsRawPromise = (await api.query.staking.nominators.entries())
		.map(async ([stashKey, nomination]) => {
			const stash = api.createType('AccountId', stashKey.slice(-32));
			// all nominators should have a stash and ledger; qed.
			const ctrl = (await api.query.staking.bonded(stash)).unwrap()
			const ledger = (await api.query.staking.ledger(ctrl));
			const stake = ledger.unwrapOrDefault().total.toBn();
			allVotes += nomination.unwrapOrDefault().targets.length;
			return { ctrl, stake, ledger }
		})

	const allNominatorsRaw = await Promise.all(AllNominatorsRawPromise);
	const allNominators = allNominatorsRaw
		.filter( ({ ctrl, stake, ledger }) => {
			if (stake.isZero() && ledger.isNone) {
				console.log(`😱 ${ctrl} seems to have no ledger. This is a state bug.`);
				return false
			} else {
				return true
			}
		})

	// sort
	allNominators.sort((n1, n2) => n1.stake.cmp(n2.stake));
	// filter those that are below
	const toRemoveAll = allNominators.filter((n) => n.stake.lt(threshold));
	const ejectedStake = toRemoveAll
		.map(({ stake }) => stake)
		.reduce((prev, current) => prev = current.add(prev));
	console.log(`a total of ${toRemoveAll.length} accounts with sum stake ${api.createType("Balance", ejectedStake).toHuman()} (from the ${allNominators.length} total and ${allVotes} votes) are below the nominator threshold..`)

	// take some, or all
	const toRemoveFinal = maybeLimit === null ? toRemoveAll : toRemoveAll.slice(0, maybeLimit);
	console.log(`.. of which ${toRemoveFinal.length} will be removed in this execution.`)

	if (toRemoveFinal.length === 0) {
		throw Error("no one to chill. cannot build batch tx.")
	}

	return toRemoveFinal.map(({ ctrl, stake}) => {
		console.log(`will chill ${ctrl.toHuman()} with stake ${api.createType('Balance', stake).toHuman()}`);
		return api.tx.staking.chillOther(ctrl);
	});
}

main().catch(console.error).finally(() => process.exit());

