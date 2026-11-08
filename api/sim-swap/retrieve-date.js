// The mock operator, served at /sim-swap/v1/retrieve-date on the deployed demo.
import { handleSimSwap } from '../../src/mock-operator.js';
export const POST = (request) => handleSimSwap(request, { action: 'retrieve-date' });
