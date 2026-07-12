import {blobStoreContractTests} from './contract-test-kit.js';
import {InMemoryBlobStore} from './in-memory.js';

blobStoreContractTests('in-memory', () => new InMemoryBlobStore(() => new Date(0)));
