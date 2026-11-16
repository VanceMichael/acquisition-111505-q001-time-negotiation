import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { Archive } from './archive.mjs';
import { receiveManual } from './intake.mjs';
import { collectHistorical, CollectError, SourceError } from './collect.mjs';

export async function createIntake(directory) {
  const archive = await new Archive(directory).initialize();
  return createServer(async (incoming, outgoing) => {
    const reply = (status, body) => { outgoing.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); outgoing.end(JSON.stringify(body)); };
    try {
      if (incoming.method === 'GET' && incoming.url === '/health') return reply(200, { status: 'ok', acquisition: 'manual+historical' });
      if (incoming.method === 'GET' && incoming.url === '/api/records') return reply(200, await archive.list());
      if (incoming.method === 'GET' && incoming.url === '/api/resolutions') return reply(200, await archive.resolutions());
      if (incoming.method === 'POST' && incoming.url === '/api/collect') {
        const chunks = []; let length = 0;
        for await (const chunk of incoming) { length += chunk.length; if (length > 1048576) return reply(413, { error: '单份采集请求过大' }); chunks.push(chunk); }
        let payload;
        try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
        catch { return reply(400, { error: 'JSON 无效' }); }
        try {
          const result = await collectHistorical(archive, payload);
          return reply(result.statusCode, result.body);
        } catch (error) {
          if (error instanceof CollectError) return reply(error.statusCode, { error: error.message, ...error.details });
          if (error instanceof SourceError) return reply(502, { error: error.message, code: error.code, ...error.details });
          throw error;
        }
      }
      if (incoming.method === 'POST' && incoming.url === '/api/manual') {
        const chunks = []; let length = 0;
        for await (const chunk of incoming) { length += chunk.length; if (length > 1048576) return reply(413, { error: '单份人工收件过大' }); chunks.push(chunk); }
        let payload; try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return reply(400, { error: 'JSON 无效' }); }
        try { return reply(201, await receiveManual(archive, payload)); } catch (error) { return reply(422, { error: error.message }); }
      }
      return reply(404, { error: '路径不存在' });
    } catch (error) { return reply(500, { error: error.message }); }
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const service = await createIntake(process.env.ARCHIVE_DIR || '.local/archive');
  service.listen(Number(process.env.PORT || 3200), '0.0.0.0', () => console.log('收件服务已就绪'));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => service.close(() => process.exit(0)));
}
