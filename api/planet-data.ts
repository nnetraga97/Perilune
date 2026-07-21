import '../server/instrumentation.js';
import { observeApiRequest } from '../server/http.js';
import { planetDataRuntimeHandler } from '../server/planetDataRuntime.js';

export default {
  fetch(request: Request): Promise<Response> {
    return observeApiRequest(request, () => planetDataRuntimeHandler(request));
  },
};
