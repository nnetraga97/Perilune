import { saveItemHandler } from '../../server/saveRuntime.js';

export default {
  fetch(request: Request): Promise<Response> {
    const pathname = new URL(request.url).pathname;
    const raw = pathname.split('/').filter(Boolean).at(-1) ?? '';
    let slot = raw;
    try {
      slot = decodeURIComponent(raw);
    } catch {
      // The handler's slot validator returns the stable error response.
    }
    return saveItemHandler(request, slot);
  },
};
