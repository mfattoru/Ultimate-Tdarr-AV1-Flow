// Shared, environment-only Arr configuration injected into the two Arr nodes.
// Empty defaults keep isolated test nodes disconnected from production APIs.
const env = process.env || {};
const envValue = name => typeof env[name] === 'string' ? env[name].trim() : '';
const ARR_CONFIG = {
  radarr: {
    label: 'Radarr Movies',
    type: 'radarr',
    host: envValue('TDARR_ARR_RADARR_URL'),
    apiKey: envValue('TDARR_ARR_RADARR_API_KEY')
  },
  sonarrTv: {
    label: 'Sonarr TV',
    type: 'sonarr',
    host: envValue('TDARR_ARR_SONARR_TV_URL'),
    apiKey: envValue('TDARR_ARR_SONARR_TV_API_KEY')
  },
  sonarrAnime: {
    label: 'Sonarr Anime',
    type: 'sonarr',
    host: envValue('TDARR_ARR_SONARR_ANIME_URL'),
    apiKey: envValue('TDARR_ARR_SONARR_ANIME_API_KEY')
  }
};
