# P002 阿里云 ECS 迁移部署

该目录用于把 Tesla 播放器从 Vercel 迁移到一台阿里云 ECS。运行形态为：

- Caddy：80/443、自动申请与续期 HTTPS 证书；
- Next.js：单实例 standalone 容器，保留 Canvas/WebCodecs 播放链路；
- 数据库：第一阶段继续使用现网 Postgres，验收后再单独迁移数据；
- 媒体代理：仅按后台源配置代理，不在 Caddy 层缓存或改写 HLS，避免破坏时间轴和音画同步。

## 服务器建议

- Ubuntu 24.04 LTS x86_64；
- 2 vCPU / 4 GiB RAM；
- 系统盘 40 GiB；
- 公网 IPv4；
- 安全组只放行 22、80、443，数据库端口不对公网开放；
- 公网带宽先选按使用流量计费并设置费用告警，代理视频流量稳定后再决定是否改固定带宽。

## 首次上线

1. 把完整源码同步到服务器的 `/opt/teslabest`。
2. 复制 `.env.example` 为 `.env`，写入现网的真实环境变量；`.env` 不得提交 Git。
3. 将 `ali-test.dorezst.cn` 的 A 记录指向 ECS 公网 IP。
4. 在本目录启动：`docker compose up -d --build`。
5. 等待 `teslabest-app` 健康后，通过测试域名验证登录、后台、点播、电视直播、网络直播与弹幕。

## 数据迁移

迁移前先从现网管理后台导出全量加密备份，至少包含：管理员配置、用户、用户组、兑换码、会员有效期、设备会话、播放记录、收藏、源配置和弹幕设置。

第一阶段复用现网 Postgres，不做数据库切换。待阿里云应用稳定后，再新建独立 PostgreSQL，使用管理后台的“数据迁移”导出/导入能力完成切换。数据库切换前后都保留备份，不直接在生产库上转换存储类型。

## 域名切换与回退

1. 正式切换前把 DNS TTL 调为 300 秒。
2. 先把正式域名切到 ECS，Vercel 保留 48 小时不删除。
3. 发生登录、数据或播放代理故障时，把 DNS A/CNAME 改回 Vercel；不要在故障期间同时改播放器核心。
4. 48 小时真车验收通过后，再停用 Vercel 的视频代理入口。

## 更新与备份

- 更新前先备份 `.env`、数据库与 Docker volumes；
- 只从通过构建验证的固定 Git commit 构建镜像，不直接追踪漂移中的分支头；
- 更新命令：`docker compose build --pull app && docker compose up -d app`；
- 查看状态：`docker compose ps`；
- 查看日志：`docker compose logs --tail=200 app caddy`。
