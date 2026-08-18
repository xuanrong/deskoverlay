// @name 猫耳FM
// @description 猫耳FM 有声内容（搜索/播放），适配 DeskOverlay 音源协议
// @version 0.1.4-deskoverlay
// 适配说明：原 MusicFree 官方插件依赖 axios，本版改为 globalThis.http.get（Rust HTTP 代理，无 CORS）。
// 安装：DeskOverlay 音乐页 →「音源」→ 本地 .js 选择本文件。

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/109.0.0.0 Safari/537.36 Edg/109.0.1518.61";

function httpJson(url) {
  return globalThis.http.get(url, { headers: { "user-agent": UA, accept: "application/json", referer: "https://www.missevan.com" } })
    .then((text) => JSON.parse(text));
}

function validMusicFilter(item) {
  return String(item.pay_type) === "0"; // 只保留免费内容
}

function formatMusicItem(item) {
  return {
    id: item.id,
    artwork: item.front_cover,
    title: item.soundstr,
    artist: item.username,
    duration: item.duration || 0,
  };
}

function formatAlbumItem(item) {
  return {
    id: item.id,
    artist: item.author,
    title: item.name,
    artwork: item.cover,
    description: item.abstract,
  };
}

module.exports = {
  platform: "猫耳FM",
  version: "0.1.4-deskoverlay",
  srcUrl: "local",
  cacheControl: "no-cache",
  supportedSearchType: ["music", "album"],

  async search(keyword, page = 1, type = "music") {
    if (type === "music") {
      const res = await httpJson("https://www.missevan.com/sound/getsearch?s=" + encodeURIComponent(keyword) + "&p=" + page + "&type=3&page_size=30");
      return {
        isEnd: res.info.pagination.p >= res.info.pagination.maxpage,
        data: (res.info.Datas || []).filter(validMusicFilter).map(formatMusicItem),
      };
    }
    if (type === "album") {
      const res = await httpJson("https://www.missevan.com/dramaapi/search?s=" + encodeURIComponent(keyword) + "&page=" + page);
      return {
        isEnd: res.info.pagination.p >= res.info.pagination.maxpage,
        data: (res.info.Datas || []).filter(validMusicFilter).map(formatAlbumItem),
      };
    }
    return { isEnd: true, data: [] };
  },

  async getMediaSource(musicItem, quality) {
    if (quality === "high" || quality === "super") return;
    const res = await httpJson("https://www.missevan.com/sound/getsound?soundid=" + musicItem.id);
    return {
      url: quality === "low" ? res.info.sound.soundurl_128 : res.info.sound.soundurl,
    };
  },
};
