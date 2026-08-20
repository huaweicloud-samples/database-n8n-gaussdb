import { GaussDbApi } from '../GaussDbApi.credentials';

describe('GaussDb Credential', () => {
	const gaussDb = new GaussDbApi();

	it('should have correct metadata', () => {
		expect(gaussDb.name).toBe('gaussDbApi');
		expect(gaussDb.displayName).toBe('GaussDB');
		expect(gaussDb.documentationUrl).toBe('gaussdb');
	});

	it('should define all expected properties', () => {
		const propertyNames = gaussDb.properties.map((p) => p.name);
		expect(propertyNames).toEqual(
			expect.arrayContaining(['host', 'database', 'user', 'password', 'port', 'ssl']),
		);
	});

	it('should default port to 8000 (GaussDB default, not PG 5432)', () => {
		const port = gaussDb.properties.find((p) => p.name === 'port');
		expect(port?.type).toBe('number');
		expect(port?.default).toBe(8000);
	});

	it('should default ssl to "disable"', () => {
		const ssl = gaussDb.properties.find((p) => p.name === 'ssl');
		expect(ssl?.type).toBe('options');
		expect(ssl?.default).toBe('disable');
	});
});
