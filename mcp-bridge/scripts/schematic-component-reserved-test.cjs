const assert = require('node:assert/strict');
const process = require('node:process');

process.env.TS_NODE_COMPILER_OPTIONS = JSON.stringify({ module: 'CommonJS', moduleResolution: 'node' });
require('ts-node/register/transpile-only');
const { handleSchematicComponentEditTask: edit } = require('../src/mcp/schematic-component-edit-handler.ts');
const { requiresHostRestartForResult } = require('../src/runtime/task-timeout.ts');

function setup() {
	const state = {
		PrimitiveId: 'r1',
		ComponentType: 'part',
		X: 10,
		Y: 20,
		Rotation: 0,
		Mirror: false,
		Designator: 'R1',
		Name: 'R',
		UniqueId: 'u1',
		AddIntoBom: true,
		AddIntoPcb: true,
		Manufacturer: 'Maker',
		ManufacturerId: 'M1',
		Supplier: 'LCSC',
		SupplierId: 'C1',
		OtherProperty: { Value: '10k', Datasheet: 'url' },
		Component: { libraryUuid: 'lib', uuid: 'device' },
	};
	const fixture = { state, calls: [], effect: undefined, componentGetter: true };
	function primitive() {
		return Object.fromEntries(Object.keys(state).filter(key => key !== 'Component' || fixture.componentGetter)
			.map(key => [`getState_${key}`, () => structuredClone(state[key])]));
	}
	globalThis.eda = {
		dmt_Schematic: { async getCurrentSchematicPageInfo() { return { uuid: 'page' }; } },
		dmt_SelectControl: { async getCurrentDocumentInfo() { return { uuid: 'page', documentType: 1 }; } },
		sch_PrimitiveComponent: {
			async getAll() { return [primitive()]; },
			async getAllPrimitiveId() { return ['r1']; },
			async get() { return primitive(); },
			async modify(id, patch) {
				fixture.calls.push(structuredClone(patch));
				for (const [key, value] of Object.entries(patch))
					state[key[0].toUpperCase() + key.slice(1)] = structuredClone(value);
				fixture.effect?.(patch);
				return primitive();
			},
		},
	};
	return fixture;
}
const modify = property => edit({ action: 'modify', primitiveId: 'r1', property });
async function main() {
	for (const [key, canonical] of [
		['Device', 'library'],
		['Footprint', 'library'],
		['Symbol', 'library'],
		['Supplier Part', 'supplierId'],
		['Manufacturer', 'manufacturer'],
		['Manufacturer Part', 'manufacturerId'],
		['Supplier', 'supplier'],
	]) {
		const f = setup();
		await assert.rejects(modify({ otherProperty: { [key]: 'bad' } }), error => error.message.includes(key) && error.message.includes(canonical));
		assert.equal(f.calls.length, 0, `reserved ${key} must fail before native write`);
	}
	let f = setup();
	f.state.OtherProperty = { ...f.state.OtherProperty, 'Device': 'existing-device', 'Footprint': 'existing-fp', 'Symbol': 'existing-symbol', 'Supplier Part': 'C1' };
	let result = await modify({ supplierId: 'C2', otherProperty: { Value: '22k' } });
	assert.equal(result.ok, true);
	assert.deepEqual(f.calls[0].otherProperty, { Value: '22k', Datasheet: 'url' });
	assert.deepEqual(result.after.component, { libraryUuid: 'lib', uuid: 'device' });
	assert.deepEqual(result.bindingVerification.unavailable, ['symbol', 'footprint']);
	assert.equal(result.bindingVerification.verified, false);
	f = setup();
	f.effect = () => {
		f.state.Component.uuid = 'corrupted';
	};
	result = await modify({ supplierId: 'C2' });
	assert.equal(result.ok, false);
	assert.equal(result.reason, 'post_write_readback_mismatch');
	assert.equal(result.after.component.uuid, 'corrupted');
	assert.ok(result.mismatches.some(m => m.key === 'component.uuid' && m.expected === 'device' && m.actual === 'corrupted'));
	assert.deepEqual([result.commitUnknown, result.readbackRequired, result.nativeCallSettled], [true, true, true]);
	assert.equal(requiresHostRestartForResult('/bridge/jlceda/schematic/component-edit', { action: 'modify' }, result), false);
	f = setup();
	f.effect = () => {
		delete f.state.OtherProperty.Value;
		f.state.SupplierId = 'wrong';
	};
	result = await modify({ supplierId: 'C2', otherProperty: { Value: '22k' } });
	assert.equal(result.after.supplierId, 'wrong');
	assert.ok(result.mismatches.some(m => m.key === 'supplierId' && m.expected === 'C2' && m.actual === 'wrong'));
	assert.ok(result.mismatches.some(m => m.key === 'otherProperty.Value' && m.expected === '22k' && m.actual === null));
	f = setup();
	f.componentGetter = false;
	result = await modify({ supplierId: 'C2' });
	assert.equal(result.ok, true);
	assert.deepEqual(result.bindingVerification.unavailable, ['component', 'symbol', 'footprint']);
	f = setup();
	f.effect = () => {
		f.componentGetter = false;
	};
	result = await modify({ supplierId: 'C2' });
	assert.equal(result.ok, false);
	assert.ok(result.mismatches.some(m => m.key === 'component' && m.reason === 'binding_unreadable'));
	console.log('Schematic reserved binding and mismatch regressions passed');
}
main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
