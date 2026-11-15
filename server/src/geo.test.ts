import {afterEach, describe, expect, it} from 'vitest';
import {locateIp, setGeoLookup} from './geo.ts';

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
