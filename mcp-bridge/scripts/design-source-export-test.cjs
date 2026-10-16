const assert = require('node:assert/strict');
const process = require('node:process');

process.env.TS_NODE_COMPILER_OPTIONS = JSON.stringify({ module: 'CommonJS', moduleResolution: 'node' });
require('ts-node/register/transpile-only');

const { handleDesignSourceExportTask } = require('../src/mcp/design-source-export-handler.ts');

function component(footprint) {
	return {
		getState_Footprint() { return footprint; },
	};
}

function setRuntime({ sources, components, method = true, componentApi = true }) {
	globalThis.eda = {
		sys_FileManager: {
			...(method ? { async getDocumentFootprintSources() { return sources; } } : {}),
		},
		...(componentApi ? { pcb_PrimitiveComponent: { async getAll() { return components; } } } : {}),
	};
}

async function main() {
	setRuntime({
		sources: [],
		components: [component({ libraryUuid: 'lib', uuid: 'fp-1' }), component({ libraryUuid: 'lib', uuid: 'fp-2' })],
	});
	const populatedEmpty = await handleDesignSourceExportTask({ action: 'footprints' });
	assert.equal(populatedEmpty.ok, false);
	assert.equal(populatedEmpty.complete, false);
	assert.equal(populatedEmpty.reason, 'native_footprint_sources_empty_for_populated_pcb');
	assert.deepEqual(populatedEmpty.referencedFootprintUuids, ['fp-1', 'fp-2']);
	assert.equal(populatedEmpty.total, 0);

	setRuntime({ sources: [], components: [] });
	const genuinelyEmpty = await handleDesignSourceExportTask({ action: 'footprints' });
	assert.equal(genuinelyEmpty.ok, true);
	assert.equal(genuinelyEmpty.complete, true);
	assert.equal(genuinelyEmpty.total, 0);
	assert.deepEqual(genuinelyEmpty.sources, []);

	setRuntime({
		sources: [{ footprintUuid: 'fp-1', documentSource: 'FOOTPRINT: one' }],
		components: [component({ libraryUuid: 'lib', uuid: 'fp-1' })],
	});
	const populated = await handleDesignSourceExportTask({ action: 'footprints', includeData: true });
	assert.equal(populated.ok, true);
	assert.equal(populated.complete, true);
	assert.equal(populated.total, 1);
	assert.equal(populated.sources[0].source.data, 'FOOTPRINT: one');

	setRuntime({ sources: [], components: [component({ libraryUuid: 'lib', uuid: 'fp-1' })], method: false });
	const unavailable = await handleDesignSourceExportTask({ action: 'footprints' });
	assert.equal(unavailable.ok, false);
	assert.equal(unavailable.complete, false);
	assert.equal(unavailable.reason, 'native_footprint_sources_api_unavailable');
	assert.deepEqual(unavailable.referencedFootprintUuids, ['fp-1']);

	setRuntime({ sources: [], components: [], method: false, componentApi: false });
	const inventoryUnavailable = await handleDesignSourceExportTask({ action: 'footprints' });
	assert.equal(inventoryUnavailable.ok, false);
	assert.equal(inventoryUnavailable.complete, false);
	assert.equal(inventoryUnavailable.reason, 'pcb_footprint_reference_inventory_unavailable');

	console.log('design-source-export regression tests passed');
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
