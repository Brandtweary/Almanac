# Web search

Web search complements Almanac's installed library with current online discovery. The gateway's `web_search` tool uses a local SearXNG service with DuckDuckGo web and Zapmeta; model inference remains local. If the web is unavailable, the tool reports that failure explicitly while corpus search and source reading remain available. This is normal application functionality, not a separate cloud-model mode.

From the repository root, with port 8888 free:

```sh
export SEARXNG_SECRET="$(python3 -c 'import secrets; print(secrets.token_hex(32))')"
docker compose -f deploy/web-search.compose.yml up -d
```

Set `SEARXNG_BASE=http://127.0.0.1:8888` for a gateway running on the same host, then verify returned titles and URLs through the gateway:

```sh
curl --get http://127.0.0.1:8790/v1/web-search \
  --data-urlencode 'q=university extension crop rotation soil fertility'
```

The pinned image and [engine settings](../deploy/web-search.settings.yml) preserve the tested engine variants—[DuckDuckGo web and its HTML engine are different paths](https://docs.searxng.org/dev/engines/online/duckduckgo.html)—but upstream availability still depends on the installation's egress address, so inspect real results and failure/degradation fields rather than treating HTTP 200 as a coverage guarantee.
