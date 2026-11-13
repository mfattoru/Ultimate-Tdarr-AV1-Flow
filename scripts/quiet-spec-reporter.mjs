import { Readable } from 'node:stream';

export default async function* quietSpec(source) {
  if (process.stdout.isTTY && process.env.FORCE_COLOR === undefined && process.env.NO_COLOR === undefined) {
    process.env.FORCE_COLOR = '1';
  }
  const { spec } = await import('node:test/reporters');
  const reporter = new spec();
  const filtered = Readable.from((async function* () {
    for await (const event of source) {
      if (event.type === 'test:stdout' || event.type === 'test:stderr') continue;
      yield event;
    }
  })(), { objectMode: true });

  filtered.pipe(reporter);
  for await (const chunk of reporter) {
    yield chunk;
  }
}
