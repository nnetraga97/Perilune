import '../../server/instrumentation.js';
import { observeApiRequest } from '../../server/http.js';
import { saveCollectionHandler } from '../../server/saveRuntime.js';

export default {
  fetch(request: Request): Promise<Response> {
    return observeApiRequest(request, () => saveCollectionHandler(request));
  },
};
