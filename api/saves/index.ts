import { saveCollectionHandler } from '../../server/saveRuntime.js';

export default {
  fetch(request: Request): Promise<Response> {
    return saveCollectionHandler(request);
  },
};
