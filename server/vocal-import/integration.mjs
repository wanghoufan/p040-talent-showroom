import { authenticateOwner } from '../requests/service.mjs';
import { createSourcePolicy } from './source-policy.mjs';
import { openVocalImportQueue } from './queue.mjs';
import { mountVocalImportRoutes } from './routes.mjs';
import { createLocalSeparator } from './separator.mjs';
import { createRepertoireImporter } from './importer.mjs';

/**
 * 把 V3.1 队列、本机分离器、曲库入库和路由装配成一个可直接挂到
 * `server/index.mjs` 的模块。没有配置任何白名单根目录时返回 null，
 * 不暴露接口、不启动后台循环。
 *
 * 注意：路由必须挂在既有 owner 配对鉴权之后；本模块不自行注册 HTTP 服务。
 */
export function createVocalImportIntegration({ db, mediaRoot, config, logger = null } = {}) {
  if (!db || !mediaRoot || !config) return null;
  if (!Array.isArray(config.roots) || config.roots.length === 0) return null;

  const policy = createSourcePolicy({ roots: config.roots });
  const extractor = createLocalSeparator({ ...(config.separator ?? {}), mediaRoot, logger });
  const importer = createRepertoireImporter({ db, mediaRoot, policy, logger });
  const { queue, recovered } = openVocalImportQueue({ db, policy, mediaRoot, extractor, importer, logger });
  // 设备未配对（owner_credentials 为空）时也必须拒绝：不能因为“还没配对”
  // 就让本机目录扫描/提取接口变成公开接口。
  const authorize = req => {
    const header = req.headers?.authorization;
    const token = typeof header === 'string' ? header.replace(/^Bearer /, '') : '';
    return Boolean(token) && authenticateOwner(db, token);
  };
  const handle = mountVocalImportRoutes({ policy, queue, authorize, logger });
  const worker = config.worker ? queue.startWorker({ intervalMs: 1000 }) : null;

  return {
    policy,
    queue,
    handle,
    worker,
    recovered,
    close() {
      worker?.stop();
    },
  };
}
