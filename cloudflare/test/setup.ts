import { env,applyD1Migrations } from "cloudflare:test";
import { fetchMock } from "./outboundMock";
import { beforeAll,afterEach } from "vitest";
beforeAll(async()=>{
  await applyD1Migrations(env.DB,env.TEST_MIGRATIONS);
  fetchMock.activate();fetchMock.disableNetConnect();
});
afterEach(()=>{fetchMock.assertNoPendingInterceptors();});
