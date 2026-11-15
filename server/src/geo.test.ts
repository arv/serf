import {afterEach, describe, expect, it} from 'vitest';
import {cloudflareLocation, locate, locateIp, setGeoLookup} from './geo.ts';

afterEach(() => setGeoLookup(null));

describe('locateIp', () => {
  it('hands an IPv4-mapped peer to the lookup bare', async () => {
    const asked: string[] = [];
    setGeoLookup(ip => {
      asked.push(ip);
      return null;
    });
    await locateIp('::ffff:203.0.113.7');
    await locateIp('2001:db8::1');
    expect(asked).toEqual(['203.0.113.7', '2001:db8::1']);
  });

  it('answers nowhere rather than throwing when the lookup fails', async () => {
    setGeoLookup(() => {
      throw new Error('database gone');
    });
    expect(await locateIp('203.0.113.7')).toBeNull();
  });

  it('places a public address and shrugs at a private one', async () => {
    // The bundled database itself, once: the shape it answers in is the
    // one thing a stub cannot vouch for.
    const dns = await locateIp('8.8.8.8');
    expect(dns?.country).toBe('US');
    expect(await locateIp('127.0.0.1')).toBeNull();
    expect(await locateIp('unknown')).toBeNull();
  });
});

describe('cloudflareLocation', () => {
  it('reads a city sent as UTF-8 through a Latin-1 header', () => {
    const wire = Buffer.from('Jönköping', 'utf8').toString('latin1');
    expect(
      cloudflareLocation({
        'cf-ipcountry': 'SE',
        'cf-region-code': 'F',
        'cf-ipcity': wire,
      }),
    ).toEqual({country: 'SE', region: 'F', city: 'Jönköping'});
  });

  it('takes a bare country, and nothing from a non-place', () => {
    expect(cloudflareLocation({'cf-ipcountry': 'se'})).toEqual({country: 'SE'});
    expect(cloudflareLocation({'cf-ipcountry': 'XX'})).toBeNull();
    expect(cloudflareLocation({'cf-ipcountry': 'T1'})).toBeNull();
    expect(cloudflareLocation({'cf-ipcity': 'Nowhere'})).toBeNull();
  });
});

describe('locate', () => {
  it("prefers Cloudflare's city to the database's", async () => {
    setGeoLookup(() => ({country: 'SE', city: 'Slottsbron'}));
    expect(
      await locate('203.0.113.7', {country: 'SE', city: 'Jönköping'}),
    ).toEqual({country: 'SE', city: 'Jönköping'});
  });

  it("keeps the database's city only under a country both agree on", async () => {
    setGeoLookup(() => ({country: 'SE', region: 'S', city: 'Slottsbron'}));
    expect(await locate('203.0.113.7', {country: 'SE'})).toEqual({
      country: 'SE',
      region: 'S',
      city: 'Slottsbron',
    });
    setGeoLookup(() => ({country: 'CZ', city: 'Destne'}));
    expect(await locate('203.0.113.7', {country: 'SE'})).toEqual({
      country: 'SE',
    });
  });

  it('falls back to the database with nothing from Cloudflare', async () => {
    setGeoLookup(() => ({country: 'IE'}));
    expect(await locate('203.0.113.7', null)).toEqual({country: 'IE'});
  });
});
