import '../server/instrumentation.js';
import { flightDirectorRuntimeHandler } from '../server/flightDirectorRuntime.js';
import { observeApiRequest } from '../server/http.js';

export default {
  fetch(request: Request): Promise<Response> {
    return observeApiRequest(request, () => flightDirectorRuntimeHandler(request));
  },
};
