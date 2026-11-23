# 小鱼缸官网 · 部署说明

线上地址：<https://tinyfish.memorymap.cn>

## 一、这台机器的既有约定（照抄自 lottery / shake 两站）

| 项 | 值 |
|---|---|
| 实例 | 腾讯云轻量 `lhins-ruhrv0i4`（`ap-beijing`，`49.233.37.122`） |
| 运维通道 | 腾讯云 TAT（**没有 SSH**），跑 `_dev_tools/tat.py` |
| 站点目录 | `/var/www/tinyfish` |
| nginx 配置 | `/etc/nginx/conf.d/tinyfish.memorymap.cn.conf` |
| 证书 | certbot 独立证书 `/etc/letsencrypt/live/tinyfish.memorymap.cn/` |
| 证书续期 | `certbot.timer`（已 enabled，全站共用） |
| 日志 | `/var/log/nginx/tinyfish.memorymap.cn.{access,error}.log` |

## 二、DNS

DNSPod 托管在 `memorymap.cn` 下，已加：

```
tinyfish   A   49.233.37.122   TTL 600   （RecordId 2457021179）
```

## 三、首次部署（已执行，2026-11-23）

```bash
# 1. 推文件（大文件 gzip + 分块，TAT 单次 Content 有 64KB 上限，单次 send 约 3 分钟）
python _dev_tools/push-site.py

# 2. 推 nginx 配置
#    ⚠️ 不能用 `tat.py put /etc/nginx/...` —— Git Bash 会把以 / 开头的参数当成
#    MSYS 路径改写成 `D:/Program Files/wb/.../etc/nginx/...`，远端收到的是垃圾路径。
#    必须走 python，让字符串原样进 ABI：
python -c "import sys;sys.path.insert(0,'_dev_tools');import tat;print(tat.put('官网/deploy/tinyfish.memorymap.cn.conf','/etc/nginx/conf.d/tinyfish.memorymap.cn.conf'))"

# 3. 语法检查 + 重载
python _dev_tools/tat.py sh -c "nginx -t 2>&1 | tail -2 && systemctl reload nginx"

# 4. 签证书（certbot 会自己往 conf 里写 443 段和 80→443 跳转）
python _dev_tools/tat.py sh -c "certbot --nginx -d tinyfish.memorymap.cn --non-interactive --agree-tos --redirect 2>&1 | tail -14" --timeout=240
```

**坑：certbot 会改写这个 conf 并把 `listen 80` 段换成 `return 404`。** 之后的修改必须基于
`官网/deploy/tinyfish.memorymap.cn.conf`（它已是 certbot 改写后的最终态），不能拿 80-only 版本覆盖，
否则 443 段消失、`nginx -t` 直接失败。

**坑：`add_header` 会阻断父级继承。** server 级的安全头一旦被任何 `location` 里的 `add_header`
覆盖，那个 location 的响应就**没有 CSP**（`/index.html` 踩过）。所以缓存策略一律用 `expires`，
不要在 location 里写 `add_header Cache-Control`。

## 四、日常更新页面

只改 `官网/index.html` 或 `官网/assets/*` 后：

```bash
python _dev_tools/push-site.py
```

`index.html` 走 `Cache-Control: no-cache`，改完即生效；`assets/` 下有 7 天缓存，
**换图必须换文件名**（例如 `tour-feeding-v2.webp`），否则老访客看不到新图。

## 五、回滚

```bash
# 只回滚页面：本地 git/备份恢复 index.html 后重新 push-site.py
# 彻底下线：
python _dev_tools/tat.py sh -c \
  "rm -f /etc/nginx/conf.d/tinyfish.memorymap.cn.conf && nginx -t && systemctl reload nginx"
```

DNS 记录在 DNSPod 控制台删 `tinyfish` 那条即可（`/var/www/tinyfish` 可留作归档）。
