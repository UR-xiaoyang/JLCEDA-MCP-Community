const assert = require('node:assert/strict');
const process = require('node:process');

process.env.TS_NODE_COMPILER_OPTIONS = JSON.stringify({ module: 'CommonJS', moduleResolution: 'node' });
require('ts-node/register/transpile-only');
const { handlePcbRoutingEditTask } = require('../src/mcp/pcb-routing-edit-handler.ts');
const { requiresHostRestartForResult } = require('../src/runtime/task-timeout.ts');
const { toSerializableAsync } = require('../src/utils.ts');

function line(id, x1, y1, x2, y2, patch = {}) {
	return { primitiveId: id, net: 'GND', layer: 1, lineWidth: 0.2, primitiveLock: false, startX: x1, startY: y1, endX: x2, endY: y2, ...patch };
}
function primitive(state) {
	return Object.fromEntries(Object.entries(state).map(([key, value]) => [`getState_${key[0].toUpperCase()}${key.slice(1)}`, () => value]));
}
function original() {
	return [line('target', 0, -5, 30, 0), line('cross-a', 10, -10, 10, 10), line('cross-b', 20, -10, 20, 10)];
}
function split() {
	return [line('a', 0, 0, 10, 0), line('b', 20, 0, 10, 0), line('c', 20, 0, 30, 0), line('d', 10, -10, 10, 0), line('e', 10, 0, 10, 10), line('f', 20, -10, 20, 0), line('g', 20, 0, 20, 10)];
}
async function run(after, { before = original(), timeout = false, changePage = false } = {}) {
	let states = before;
	let writes = 0;
	let page = 'pcb';
	globalThis.eda = {
		dmt_Pcb: { async getCurrentPcbInfo() { return { uuid: page }; } },
		pcb_Layer: { async getAllLayers() { return [{ id: 1, type: 'SIGNAL', layerStatus: 1 }]; } },
		pcb_Net: { async getAllNets() { return [{ net: 'GND' }]; } },
		pcb_PrimitiveLine: {
			async get(id) {
				const state = states.find(item => item.primitiveId === id);
				return state ? primitive(state) : undefined;
			},
			async getAll() { return states.map(primitive); },
			async modify() {
				writes++;
				states = after;
				if (changePage)
					page = 'other';
				if (timeout)
					throw new Error('RPC Call Timed Out');
				return undefined;
			},
		},
	};
	const result = await toSerializableAsync(await handlePcbRoutingEditTask({ action: 'modify', kind: 'line', primitiveId: 'target', property: { startY: 0 } }));
	return { result, writes };
}
async function main() {
	const { result, writes } = await run(split());
	assert.equal(result.ok, true, 'three old lines replaced by seven equivalent segments must verify');
	assert.equal(result.verified, true);
	assert.equal(result.commitUnknown, undefined);
	assert.equal(writes, 1);
	assert.deepEqual([...result.primitiveIds].sort(), ['a', 'b', 'c']);
	assert.equal(result.normalization.kind, 'split_or_merged_line');
	for (const [name, mutate] of [
		['target gap', rows => rows.filter(row => row.primitiveId !== 'b')],
		['other old line gap', rows => rows.filter(row => row.primitiveId !== 'g')],
		['wrong layer', rows => rows.map(row => row.primitiveId === 'b' ? { ...row, layer: 2 } : row)],
		['wrong net', rows => rows.map(row => row.primitiveId === 'b' ? { ...row, net: 'VCC' } : row)],
		['wrong width', rows => rows.map(row => row.primitiveId === 'b' ? { ...row, lineWidth: 0.3 } : row)],
		['wrong lock', rows => rows.map(row => row.primitiveId === 'b' ? { ...row, primitiveLock: true } : row)],
		['unexpected branch', rows => [...rows, line('branch', 15, 0, 15, 15)]],
		['extension', rows => rows.map(row => row.primitiveId === 'c' ? { ...row, endX: 31 } : row)],
		['old target remains', rows => [...rows, original()[0]]],
		['off-axis', rows => rows.map(row => row.primitiveId === 'b' ? { ...row, startY: 0.0001 } : row)],
	]) {
		const { result: rejected, writes: count } = await run(mutate(split()));
		assert.equal(rejected.ok, false, name);
		assert.equal(rejected.commitUnknown, true, name);
		assert.equal(rejected.nativeCallSettled, true, name);
		assert.equal(rejected.readbackRequired, true, name);
		assert.equal(count, 1, name);
		assert.ok(rejected.affectedLines.before.length <= 32, name);
		assert.ok(rejected.affectedLines.after.length <= 32, name);
	}
	const retained = split();
	retained[0].primitiveId = 'target';
	assert.equal((await run(retained)).result.ok, true, 'old ID can survive as one split segment');
	const unchangedId = [line('target', 0, -5, 30, 0)];
	assert.equal((await run([line('target', 0, 0, 30, 0)], { before: unchangedId })).result.ok, true);
	const timedOut = (await run(split(), { timeout: true })).result;
	assert.equal(timedOut.nativeCallSettled, false);
	assert.equal(requiresHostRestartForResult('/bridge/jlceda/pcb/routing-edit', {}, timedOut), true);
	assert.equal((await run(split(), { changePage: true })).result.commitUnknown, true);
	console.log('PCB routing split modify tests passed');
}
main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
