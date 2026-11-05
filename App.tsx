import React, { useEffect, useMemo, useRef, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  ActivityIndicator,
  FlatList,
  Image,
  Modal,
  SafeAreaView,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
  useWindowDimensions,
} from 'react-native';
import StreamVideo from './StreamVideo';

type Kind = 'live' | 'movies' | 'series' | 'radio';
type MediaItem = { id: string; name: string; url: string; group: string; kind: Kind; tvgId?: string; logo?: string };
type Playlist = { id: string; name: string; url: string; epgUrl?: string };
type GuideProgram = { start: number; stop: number; title: string; description?: string };
type GuideMap = Record<string, GuideProgram[]>;
type LibraryMode = 'all' | 'favorites' | 'recent';
type AddMode = 'choose' | 'm3u' | 'xtream';
type XtreamOutput = 'ts' | 'm3u8';
type PlaylistLoadStat = { durationMs: number; count: number };
type PlaylistExpiry = { status: 'checking' | 'known' | 'never' | 'unknown' | 'unavailable'; expiresAt?: number };
type WatchProgress = Record<string, { position: number; duration: number }>;
type NavigationState = { active: Kind | null; group: string | null; seriesTitle: string | null; seriesSeason: number | null };
type TrackOption = { id: string; label: string };
const CONTINUE_GROUP = '__getiptv_continue__';
type ParsedEpisode = { title: string; season: number; episode: number };
type SeriesFolder = { key: string; title: string; group: string; episodes: MediaItem[] };
type PlaybackSeason = { season: number; episodes: MediaItem[] };
type SeriesPlaybackNavigation = { seasons: PlaybackSeason[]; selectedSeason: number; currentItemId: string; onSelectSeason: (season: number) => void; onSelectEpisode: (item: MediaItem, queue: MediaItem[]) => void };

function ArtworkBadge({ item, style }: { item: MediaItem; style?: object }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [item.id, item.logo]);
  return <View style={[styles.channelLogo, { backgroundColor: `${PALETTE[item.kind]}55` }, style]}>{item.logo && !failed ? <Image source={{ uri: item.logo }} resizeMode={item.kind === 'live' ? 'contain' : 'cover'} onError={() => setFailed(true)} style={styles.artworkImage} /> : <Text style={styles.channelLogoText}>{item.name.slice(0, 2).toLocaleUpperCase('tr')}</Text>}</View>;
}
function parseEpisodeName(name: string): ParsedEpisode | null {
  const patterns = [
    /^(.*?)[\s._-]+S(?:EASON)?\s*0*(\d{1,2})[\s._-]*E(?:P(?:ISODE)?)?\s*0*(\d{1,3})\b/i,
    /^(.*?)[\s._-]+Season\s*0*(\d{1,2})[\s._-]+Episode\s*0*(\d{1,3})\b/i,
    /^(.*?)[\s._-]+0*(\d{1,2})x0*(\d{1,3})\b/i,
  ];
  for (const pattern of patterns) {
    const match = name.match(pattern);
    if (match) return { title: match[1].replace(/[\s._-]+$/, '').trim() || name, season: Number(match[2]), episode: Number(match[3]) };
  }
  return null;
}
const normalizeText = (value: string) => value.toLocaleLowerCase('tr').replace(/ı/g, 'i').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const parseStoredIds = (value: string | null) => { try { const parsed = value ? JSON.parse(value) : []; return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : []; } catch { return []; } };
const PALETTE: Record<Kind, string> = {
  live: '#079AA4', movies: '#C66A2D', series: '#7046C5', radio: '#B53679',
};
const SECTIONS: { id: Kind; title: string; icon: string; subtitle: string }[] = [
  { id: 'live', title: 'Canlı TV', icon: '◉', subtitle: 'Canlı yayınlar' },
  { id: 'movies', title: 'Filmler', icon: '▣', subtitle: 'Film ve sinema' },
  { id: 'series', title: 'Diziler', icon: '▤', subtitle: 'Dizi ve bölümler' },
  { id: 'radio', title: 'Radyo', icon: '♫', subtitle: 'Müzik ve radyo' },
];

function classify(name: string, group: string, url = ''): Kind {
  // Provider endpoints are the strongest signal: live channel groups can contain words like
  // "dizi" or "film" while still being linear broadcasts.
  const path = normalizeText(url.split(/[?#]/, 1)[0]);
  if (/\/(?:live|tv)\//.test(path)) return 'live';
  if (/\/series\//.test(path)) return 'series';
  if (/\/(?:movie|movies|vod)\//.test(path)) return 'movies';
  const text = normalizeText(`${name} ${group}`);
  if (/radio|radyo|fm\b|music|müzik/.test(text)) return 'radio';
  if (/s\d{1,2}\s?e\d{1,2}|\b\d{1,2}x\d{1,2}\b|season|sezon|episode|bölüm|dizi|series/.test(text)) return 'series';
  if (/film|movie|cinema|sinema|vod/.test(text)) return 'movies';
  return 'live';
}

function parseM3u(source: string): MediaItem[] {
  const result: MediaItem[] = [];
  let info = '';
  let cursor = source.charCodeAt(0) === 0xFEFF ? 1 : 0;
  while (cursor < source.length) {
    const lineEnd = source.indexOf('\n', cursor);
    const rawLine = source.slice(cursor, lineEnd < 0 ? source.length : lineEnd);
    cursor = lineEnd < 0 ? source.length : lineEnd + 1;
    const line = rawLine.trim();
    if (line.startsWith('#EXTINF')) { info = line; continue; }
    if (!line || line.startsWith('#') || !info) continue;
    const comma = info.lastIndexOf(',');
    const name = (comma >= 0 ? info.slice(comma + 1) : 'İsimsiz yayın').trim();
    const group = info.match(/group-title=["']([^"']*)["']/i)?.[1]?.trim() || 'Diğer / Belirtilmemiş';
    const tvgId = info.match(/tvg-id=["']([^"']*)["']/i)?.[1]?.trim();
    const logo = info.match(/(?:tvg-logo|logo)=["']?([^"'\s>]+)["']?/i)?.[1]?.trim().replace(/&amp;/gi, '&');
    result.push({ id: `${result.length}-${line}`, name, url: line, group, kind: classify(name, group, line), tvgId: tvgId || undefined, logo: logo || undefined });
    info = '';
  }
  return result;
}

function getPlaylistEpgUrl(playlistUrl: string, source = ''): string | null {
  const header = source.replace(/^\uFEFF/, '').match(/^#EXTM3U[^\r\n]*(?:url-tvg|x-tvg-url)=["']?([^"'\s]+)["']?/im)?.[1]?.split(',')[0]?.trim();
  if (header && /^https?:\/\//i.test(header)) return header;
  try {
    const playlist = new URL(playlistUrl);
    if (!/\/get\.php$/i.test(playlist.pathname)) return null;
    const username = playlist.searchParams.get('username');
    const password = playlist.searchParams.get('password');
    if (!username || !password) return null;
    playlist.pathname = playlist.pathname.replace(/get\.php$/i, 'xmltv.php');
    playlist.search = '';
    playlist.searchParams.set('username', username);
    playlist.searchParams.set('password', password);
    return playlist.toString();
  } catch { return null; }
}

function decodeXmlText(value: string) {
  return value.replace(/&#x([\da-f]+);/gi, (_match, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").trim();
}

function parseXmltvDate(value: string) {
  const match = value.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\s*([+-]\d{4})?/);
  if (!match) return 0;
  const offset = match[7] || '+0000';
  const iso = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}${offset.slice(0, 3)}:${offset.slice(3)}`;
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseXmltv(source: string): GuideMap {
  const programs: GuideMap = {};
  const now = Date.now();
  const windowStart = now - 30 * 60_000;
  const windowEnd = now + 8 * 60 * 60_000;
  const expression = /<programme\b([^>]*)>([\s\S]*?)<\/programme>/gi;
  let match: RegExpExecArray | null;
  while ((match = expression.exec(source))) {
    const attrs = match[1];
    const body = match[2];
    const channel = attrs.match(/\bchannel=["']([^"']+)["']/i)?.[1];
    if (!channel) continue;
    const start = parseXmltvDate(attrs.match(/\bstart=["']([^"']+)["']/i)?.[1] || '');
    const stop = parseXmltvDate(attrs.match(/\bstop=["']([^"']+)["']/i)?.[1] || '');
    if (!start || !stop || stop <= windowStart || start >= windowEnd) continue;
    const title = decodeXmlText(body.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '');
    if (!title) continue;
    const description = decodeXmlText(body.match(/<desc\b[^>]*>([\s\S]*?)<\/desc>/i)?.[1] || '');
    const channelKey = normalizeText(channel);
    (programs[channelKey] ||= []).push({ start, stop, title, description: description || undefined });
  }
  for (const entries of Object.values(programs)) entries.sort((a, b) => a.start - b.start);
  return programs;
}

function cacheKeyForPlaylist(id: string) {
  let hash = 2166136261;
  for (let index = 0; index < id.length; index += 1) hash = Math.imul(hash ^ id.charCodeAt(index), 16777619);
  return (hash >>> 0).toString(36);
}

function getProgramPair(entries: GuideProgram[] | undefined, now: number) {
  if (!entries?.length) return { current: undefined as GuideProgram | undefined, next: undefined as GuideProgram | undefined };
  return {
    current: entries.find((program) => program.start <= now && program.stop > now),
    next: entries.find((program) => program.start > now),
  };
}

function StreamPlayer({ item, onClose, onPrevious, onNext, resumeAt = 0, onProgress, onRestart, compact = false, fullscreenRequest = 0, seriesNavigation }: { item: MediaItem; onClose: () => void; onPrevious: () => void; onNext: () => void; resumeAt?: number; onProgress: (position: number, duration: number) => void; onRestart: () => void; compact?: boolean; fullscreenRequest?: number; seriesNavigation?: SeriesPlaybackNavigation }) {
  const [playbackAttempt, setPlaybackAttempt] = useState(0);
  const [selectedAudio, setSelectedAudio] = useState<string | null>(null);
  const [selectedSubtitle, setSelectedSubtitle] = useState<string | null>(null);
  useEffect(() => { setSelectedAudio(null); setSelectedSubtitle(null); }, [item.id]);
  const supportsTracks = item.kind === 'movies' || item.kind === 'series';
  // Keep the web player DOM element stable across channel changes so browser fullscreen stays active.
  const video = <StreamVideo reloadKey={playbackAttempt} fullscreenRequest={fullscreenRequest} uri={item.url} title={item.name} isLive={item.kind === 'live' || item.kind === 'radio'} showTrackControls={supportsTracks} compact={compact} seriesNavigation={seriesNavigation ? { seasons: seriesNavigation.seasons.map((season) => ({ season: season.season, episodes: season.episodes.map(({ id, name }) => ({ id, name })) })), selectedSeason: seriesNavigation.selectedSeason, currentItemId: seriesNavigation.currentItemId, onSelectSeason: seriesNavigation.onSelectSeason, onSelectEpisode: (id: string) => { const season = seriesNavigation.seasons.find((entry) => entry.season === seriesNavigation.selectedSeason); const episode = season?.episodes.find((entry) => entry.id === id); if (season && episode) seriesNavigation.onSelectEpisode(episode, season.episodes); } } : undefined} audioTrackId={selectedAudio} subtitleTrackId={selectedSubtitle} onSelectAudioTrack={setSelectedAudio} onSelectSubtitleTrack={setSelectedSubtitle} style={styles.video} initialPosition={resumeAt} onProgress={onProgress} onPrevious={onPrevious} onNext={onNext} onRetry={() => setPlaybackAttempt((attempt) => attempt + 1)} onClose={onClose} />;
  if (compact) return (
    <View style={styles.inlinePlayer}>
      <View style={styles.inlineVideoFrame}>{video}</View>
      <Text style={styles.playerTitle} numberOfLines={2}>{item.name}</Text>
      <Text style={styles.playerMeta}>{item.kind === 'live' ? 'Canlı yayın' : item.kind === 'movies' ? 'Film' : item.kind === 'series' ? 'Dizi' : 'Radyo'} · {item.group}</Text>
      {resumeAt > 5 ? <TouchableOpacity onPress={onRestart} style={styles.restartButton}><Text style={styles.restartText}>↺ Baştan başlat</Text></TouchableOpacity> : null}
    </View>
  );
  return (
    <SafeAreaView style={styles.playerScreen}>
      <StatusBar barStyle="light-content" backgroundColor="#050910" />
      <View style={styles.videoFrame}>{video}</View>
      <Text style={styles.playerTitle} numberOfLines={2}>{item.name}</Text>
      <Text style={styles.playerMeta}>{item.group}</Text>
      {resumeAt > 5 ? <TouchableOpacity onPress={onRestart} style={styles.restartButton}><Text style={styles.restartText}>↺ Baştan başlat</Text></TouchableOpacity> : null}
    </SafeAreaView>
  );
}

export default function App() {
  const { width: viewportWidth } = useWindowDimensions();
  const isWideLayout = viewportWidth >= 1150;
  const isCompactHome = viewportWidth < 1150;
  const [items, setItems] = useState<MediaItem[]>([]);
  const [initializing, setInitializing] = useState(true);
  const [savedPlaylists, setSavedPlaylists] = useState<Playlist[]>([]);
  const [activePlaylistId, setActivePlaylistId] = useState('');
  const [playlistLoadStats, setPlaylistLoadStats] = useState<Record<string, PlaylistLoadStat>>({});
  const [playlistExpiries, setPlaylistExpiries] = useState<Record<string, PlaylistExpiry>>({});
  const playlistExpiriesRef = useRef<Record<string, PlaylistExpiry>>({});
  const [favoriteIds, setFavoriteIds] = useState<string[]>([]);
  const [recentIds, setRecentIds] = useState<string[]>([]);
  const [watchProgress, setWatchProgress] = useState<WatchProgress>({});
  const [libraryMode, setLibraryMode] = useState<LibraryMode>('all');
  const [active, setActive] = useState<Kind | null>(null);
  const [group, setGroup] = useState<string | null>(null);
  const [seriesTitle, setSeriesTitle] = useState<string | null>(null);
  const [seriesSeason, setSeriesSeason] = useState<number | null>(null);
  const [navigationHistory, setNavigationHistory] = useState<NavigationState[]>([]);
  const [query, setQuery] = useState('');
  const [url, setUrl] = useState('');
  const [playlistName, setPlaylistName] = useState('');
  const [addMode, setAddMode] = useState<AddMode>('choose');
  const [xtreamServer, setXtreamServer] = useState('');
  const [xtreamUsername, setXtreamUsername] = useState('');
  const [xtreamPassword, setXtreamPassword] = useState('');
  const [xtreamOutput, setXtreamOutput] = useState<XtreamOutput>('m3u8');
  const [epgUrl, setEpgUrl] = useState('');
  const [activeGuideUrl, setActiveGuideUrl] = useState('');
  const [guidePrograms, setGuidePrograms] = useState<GuideMap>({});
  const [guideStatus, setGuideStatus] = useState<'idle' | 'loading' | 'ready' | 'unavailable'>('idle');
  const [guideClock, setGuideClock] = useState(Date.now());
  const activePlaylistIdRef = useRef('');
  const [adding, setAdding] = useState(false);
  const [message, setMessage] = useState('');
  const [showAdd, setShowAdd] = useState(false);
  const [showLists, setShowLists] = useState(false);
  const [showGroupPicker, setShowGroupPicker] = useState(false);
  const [showSeasonPicker, setShowSeasonPicker] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showAbout, setShowAbout] = useState(false);
  const [showGuideEditor, setShowGuideEditor] = useState(false);
  const [guideEditValue, setGuideEditValue] = useState('');
  const searchInputRef = useRef<TextInput>(null);
  const [groupSearch, setGroupSearch] = useState('');
  const [hoveredSection, setHoveredSection] = useState<Kind | null>(null);
  const [hoveredRailAction, setHoveredRailAction] = useState<string | null>(null);
  const [hoveredNavAction, setHoveredNavAction] = useState<'back' | 'home' | null>(null);
  const [current, setCurrent] = useState<MediaItem | null>(null);
  const [playerSeason, setPlayerSeason] = useState<number | null>(null);
  const [resumeAt, setResumeAt] = useState(0);
  const [playQueue, setPlayQueue] = useState<MediaItem[]>([]);
  useEffect(() => { setPlayerSeason(null); }, [current?.id]);
  const [fullscreenRequest, setFullscreenRequest] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => setGuideClock(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      AsyncStorage.getItem('getiptv.playlists'), AsyncStorage.getItem('getiptv.playlistUrl'),
      AsyncStorage.getItem('getiptv.activePlaylist'), AsyncStorage.getItem('getiptv.favorites'), AsyncStorage.getItem('getiptv.recent'), AsyncStorage.getItem('getiptv.progress'), AsyncStorage.getItem('getiptv.playlistLoadStats'), AsyncStorage.getItem('getiptv.playlistExpiries'),
    ]).then(async ([rawLists, legacyUrl, activeId, rawFavorites, rawRecent, rawProgress, rawLoadStats, rawExpiries]) => {
      let lists: Playlist[] = [];
      try { lists = rawLists ? JSON.parse(rawLists) as Playlist[] : []; } catch { lists = []; }
      if (!lists.length && legacyUrl) lists = [{ id: legacyUrl, name: 'Genel', url: legacyUrl }];
      if (cancelled) return;
      setSavedPlaylists(lists);
      setFavoriteIds(parseStoredIds(rawFavorites));
      setRecentIds(parseStoredIds(rawRecent));
      try { setWatchProgress(rawProgress ? JSON.parse(rawProgress) as WatchProgress : {}); } catch { setWatchProgress({}); }
      try { setPlaylistLoadStats(rawLoadStats ? JSON.parse(rawLoadStats) as Record<string, PlaylistLoadStat> : {}); } catch { setPlaylistLoadStats({}); }
      try {
        const expiries = rawExpiries ? JSON.parse(rawExpiries) as Record<string, PlaylistExpiry> : {};
        playlistExpiriesRef.current = expiries;
        setPlaylistExpiries(expiries);
      } catch { playlistExpiriesRef.current = {}; setPlaylistExpiries({}); }
      if (lists.length && !rawLists) await AsyncStorage.setItem('getiptv.playlists', JSON.stringify(lists));
      const selected = lists.find((list) => list.id === activeId) || lists[0];
      if (selected && !cancelled) await activatePlaylist(selected, false);
      if (!cancelled) setInitializing(false);
    }).catch(() => { if (!cancelled) { setMessage('Kayıtlı bilgiler okunamadı.'); setInitializing(false); } });
    return () => { cancelled = true; };
  }, []);

  const sourceItems = libraryMode === 'favorites'
    ? items.filter((item) => favoriteIds.includes(item.id))
    : libraryMode === 'recent'
      ? recentIds.map((id) => items.find((item) => item.id === id)).filter((item): item is MediaItem => Boolean(item))
      : items;
  const continueItems = recentIds.map((id) => items.find((item) => item.id === id)).filter((item): item is MediaItem => Boolean(item && (item.kind === 'movies' || item.kind === 'series') && watchProgress[item.id]?.position > 15 && (!watchProgress[item.id]?.duration || watchProgress[item.id].position < watchProgress[item.id].duration - 25)));
  const activeContinueItems = continueItems.filter((item) => item.kind === active);
  const baseVisible = useMemo(() => {
    const candidates = group === CONTINUE_GROUP ? activeContinueItems : sourceItems.filter((item) =>
      (!active || item.kind === active) && (!group || item.group === group));
    return candidates.filter((item) => normalizeText(item.name).includes(normalizeText(query)));
  }, [sourceItems, activeContinueItems, active, group, query]);
  const groups = useMemo(() => [...new Set(sourceItems.filter((i) => !active || i.kind === active).map((i) => i.group))].sort((a, b) => a.localeCompare(b, 'tr')), [sourceItems, active]);
  const seriesFolders = useMemo(() => {
    const folders = new Map<string, SeriesFolder>();
    // A provider can place different episodes of the same show in different groups
    // (for example, by weekday). Once a show is opened, collect its episodes across
    // the whole playlist so every season is available in the season picker.
    const seriesSource = seriesTitle ? sourceItems.filter((item) => item.kind === 'series') : baseVisible;
    for (const item of seriesSource) {
      const parsed = parseEpisodeName(item.name);
      if (!parsed) continue;
      const key = normalizeText(parsed.title);
      const folder = folders.get(key) || { key, title: parsed.title, group: item.group, episodes: [] };
      folder.episodes.push(item);
      folders.set(key, folder);
    }
    return [...folders.values()].sort((a, b) => a.title.localeCompare(b.title, 'tr'));
  }, [baseVisible, sourceItems, seriesTitle, group]);
  // Accept the older group-qualified key during hot reload/navigation so an
  // already-open series does not become temporarily detached from its folder.
  const selectedSeriesKey = seriesTitle?.includes('::') ? seriesTitle.split('::').pop() : seriesTitle;
  const selectedSeries = seriesFolders.find((folder) => folder.key === selectedSeriesKey);
  const seasonFolders = useMemo(() => {
    if (!selectedSeries) return [] as { season: number; episodes: MediaItem[] }[];
    const seasons = new Map<number, MediaItem[]>();
    for (const episode of selectedSeries.episodes) {
      const parsed = parseEpisodeName(episode.name);
      if (!parsed) continue;
      seasons.set(parsed.season, [...(seasons.get(parsed.season) || []), episode]);
    }
    return [...seasons.entries()].sort(([a], [b]) => a - b).map(([season, episodes]) => ({ season, episodes: episodes.sort((a, b) => (parseEpisodeName(a.name)?.episode || 0) - (parseEpisodeName(b.name)?.episode || 0)) }));
  }, [selectedSeries]);
  const currentEpisodeInfo = current?.kind === 'series' ? parseEpisodeName(current.name) : null;
  const playbackSeasons = useMemo(() => {
    if (!currentEpisodeInfo) return [] as PlaybackSeason[];
    const grouped = new Map<number, MediaItem[]>();
    for (const episode of items) {
      if (episode.kind !== 'series') continue;
      const parsed = parseEpisodeName(episode.name);
      if (!parsed || normalizeText(parsed.title) !== normalizeText(currentEpisodeInfo.title)) continue;
      grouped.set(parsed.season, [...(grouped.get(parsed.season) || []), episode]);
    }
    return [...grouped.entries()].sort(([a], [b]) => a - b).map(([season, episodes]) => ({ season, episodes: episodes.sort((a, b) => (parseEpisodeName(a.name)?.episode || 0) - (parseEpisodeName(b.name)?.episode || 0)) }));
  }, [items, currentEpisodeInfo?.title]);
  const playbackSeason = playbackSeasons.find((season) => season.season === playerSeason)
    || playbackSeasons.find((season) => season.season === currentEpisodeInfo?.season);
  const seriesPlaybackNavigation: SeriesPlaybackNavigation | undefined = currentEpisodeInfo && playbackSeason ? {
    seasons: playbackSeasons,
    selectedSeason: playbackSeason.season,
    currentItemId: current?.id || '',
    onSelectSeason: setPlayerSeason,
    onSelectEpisode: (episode, queue) => { void openItem(episode, queue); },
  } : undefined;
  const visible = useMemo(() => {
    if (active !== 'series' || group === CONTINUE_GROUP) return baseVisible;
    if (!seriesTitle) return baseVisible.filter((item) => !parseEpisodeName(item.name));
    if (seriesSeason === null) return seasonFolders.length ? [] : selectedSeries?.episodes || [];
    return (seasonFolders.find((season) => season.season === seriesSeason)?.episodes || []);
  }, [active, group, baseVisible, seriesTitle, seriesSeason, seasonFolders, selectedSeries]);
  const matchingGroups = useMemo(() => groups.filter((name) => normalizeText(name).includes(normalizeText(groupSearch))), [groups, groupSearch]);
  const activePlaylistName = savedPlaylists.find((list) => list.id === activePlaylistId)?.name || 'Genel';
  const activeLoadStat = playlistLoadStats[activePlaylistId];
  const loadDurationText = activeLoadStat ? `${(activeLoadStat.durationMs / 1000).toFixed(1).replace('.', ',')} sn` : '';
  const activeExpiry = playlistExpiries[activePlaylistId];
  const expiryDate = activeExpiry?.expiresAt ? new Date(activeExpiry.expiresAt) : null;
  const expiryText = activeExpiry?.status === 'known' && expiryDate
    ? `Bitiş tarihi: ${String(expiryDate.getDate()).padStart(2, '0')}.${String(expiryDate.getMonth() + 1).padStart(2, '0')}.${expiryDate.getFullYear()}`
    : activeExpiry?.status === 'never' ? 'Bitiş tarihi: süresiz'
      : activeExpiry?.status === 'checking' ? 'Bitiş tarihi: kontrol ediliyor…'
        : activeExpiry?.status === 'unavailable' ? 'Bitiş tarihi: sağlayıcıdan alınamadı'
          : 'Bitiş tarihi: sağlayıcı bilgisi yok';
  const groupCount = (name: string | null) => name === CONTINUE_GROUP ? activeContinueItems.length : sourceItems.filter((item) => (!active || item.kind === active) && (!name || item.group === name)).length;
  const renderChannel = ({ item }: { item: MediaItem }) => {
    const guide = item.kind === 'live' && item.tvgId ? getProgramPair(guidePrograms[normalizeText(item.tvgId)], guideClock) : { current: undefined, next: undefined };
    return <View style={[styles.channel, (item.kind === 'movies' || item.kind === 'series') && styles.channelWithPoster, guide.current && styles.channelWithGuide]}><TouchableOpacity style={styles.channelMain} onPress={() => openItem(item)} {...({ onDoubleClick: () => openItem(item, visible, true) } as any)}><ArtworkBadge item={item} style={(item.kind === 'movies' || item.kind === 'series') ? styles.posterArtwork : undefined} /><View style={{ flex: 1, minWidth: 0 }}><Text style={styles.channelName} numberOfLines={1}>{item.name}</Text><Text style={styles.channelGroup} numberOfLines={1}>{item.group}</Text>{guide.current ? <><Text style={styles.channelProgram} numberOfLines={1}><Text style={styles.programLiveDot}>● </Text>{new Date(guide.current.start).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })} · {guide.current.title}</Text>{guide.next ? <Text style={styles.channelNext} numberOfLines={1}>Sıradaki {new Date(guide.next.start).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })} · {guide.next.title}</Text> : null}</> : null}</View><Text style={styles.playIcon}>▶</Text></TouchableOpacity><TouchableOpacity accessibilityRole="button" accessibilityLabel={favoriteIds.includes(item.id) ? 'Favorilerden çıkar' : 'Favorilere ekle'} style={styles.favoriteButton} onPress={() => toggleFavorite(item)}><Text style={[styles.favoriteGlyph, favoriteIds.includes(item.id) && styles.favoriteActive]}>{favoriteIds.includes(item.id) ? '★' : '☆'}</Text></TouchableOpacity></View>;
  };
  const guideStatusText = guideStatus === 'loading' ? 'Rehber yükleniyor…' : guideStatus === 'ready' ? `EPG hazır · ${Object.keys(guidePrograms).length} kanal` : guideStatus === 'unavailable' ? 'Bu listede EPG bulunamadı' : 'EPG bekleniyor';
  const renderGuideStatus = () => active === 'live' ? <View style={styles.guideStatusRow}><Text style={[styles.guideStatusText, guideStatus === 'ready' && styles.guideStatusReady]}>{guideStatus === 'ready' ? '● ' : '◷ '}{guideStatusText}</Text><View style={styles.guideActions}>{activeGuideUrl && guideStatus !== 'loading' ? <TouchableOpacity accessibilityRole="button" onPress={() => { if (activePlaylistId) void refreshGuide(activePlaylistId, activeGuideUrl); }}><Text style={styles.guideRetry}>Yenile</Text></TouchableOpacity> : null}{guideStatus !== 'loading' ? <TouchableOpacity accessibilityRole="button" onPress={() => { setGuideEditValue(activeGuideUrl); setShowGuideEditor(true); }}><Text style={styles.guideRetry}>{activeGuideUrl ? 'Düzenle' : 'EPG ekle'}</Text></TouchableOpacity> : null}</View></View> : null;
  const renderEmpty = () => <Text style={styles.empty}>{group === CONTINUE_GROUP ? 'Bu kategoride devam edilecek içerik yok.' : items.length ? 'Bu kategoride içerik yok.' : 'Önce bir yayın listesi ekle.'}</Text>;
  const isSeriesBrowse = active === 'series' && group !== CONTINUE_GROUP;
  const seriesCountText = !seriesTitle ? `${seriesFolders.length.toLocaleString('tr-TR')} dizi` : seriesSeason === null && seasonFolders.length ? `${seasonFolders.length.toLocaleString('tr-TR')} sezon` : `${visible.length.toLocaleString('tr-TR')} bölüm`;
  const seriesHeading = !seriesTitle ? 'DİZİLER' : seriesSeason === null && seasonFolders.length ? selectedSeries?.title || 'SEZONLAR' : seriesSeason !== null ? `SEZON ${seriesSeason}` : selectedSeries?.title || 'BÖLÜMLER';
  const contentList = isSeriesBrowse && !seriesTitle && seriesFolders.length ? <FlatList data={seriesFolders} keyExtractor={(folder) => folder.key} contentContainerStyle={styles.channelList} initialNumToRender={24} windowSize={9} renderItem={({ item: folder }) => <TouchableOpacity style={styles.seriesFolderCard} onPress={() => openSeries(folder.key)}><ArtworkBadge item={folder.episodes[0]} style={styles.seriesFolderIcon} /><View style={{ flex: 1 }}><Text style={styles.seriesFolderTitle} numberOfLines={2}>{folder.title}</Text><Text style={styles.channelGroup} numberOfLines={1}>{folder.group}</Text></View><Text style={styles.seriesFolderCount}>{folder.episodes.length} bölüm　›</Text></TouchableOpacity>} />
    : isSeriesBrowse && seriesTitle ? <View style={styles.seriesEpisodePane}>
      <TouchableOpacity accessibilityRole="button" accessibilityLabel="Sezon seç" style={styles.seasonSelectButton} onPress={() => setShowSeasonPicker((open) => !open)}>
        <View><Text style={styles.seasonSelectLabel}>SEZON SEÇİMİ</Text><Text style={styles.seasonSelectValue}>{seriesSeason === null ? 'Bir sezon seç' : `Sezon ${seriesSeason}`}</Text></View><Text style={styles.seriesFolderCount}>{showSeasonPicker ? '⌃' : '⌄'}</Text>
      </TouchableOpacity>
      {showSeasonPicker ? <ScrollView style={styles.seasonInlineList} nestedScrollEnabled showsVerticalScrollIndicator>{seasonFolders.map((season) => <TouchableOpacity key={season.season} style={[styles.seasonInlineOption, seriesSeason === season.season && styles.seasonInlineOptionActive]} onPress={() => openSeason(season.season)}><Text style={styles.seasonInlineName}>Sezon {season.season}</Text><Text style={styles.seasonInlineCount}>{season.episodes.length} bölüm</Text></TouchableOpacity>)}</ScrollView> : null}
      {seriesSeason === null ? <Text style={styles.empty}>Bölümleri görmek için bir sezon seç.</Text> : <FlatList data={visible} keyExtractor={(item) => item.id} contentContainerStyle={styles.channelList} initialNumToRender={24} windowSize={9} ListEmptyComponent={renderEmpty} renderItem={renderChannel} />}
    </View>
      : <FlatList data={visible} keyExtractor={(item) => item.id} contentContainerStyle={styles.channelList} initialNumToRender={24} windowSize={9} ListEmptyComponent={renderEmpty} renderItem={renderChannel} />;
  const renderLibraryModes = () => <ScrollView horizontal style={styles.libraryModesScroll} showsHorizontalScrollIndicator={false} contentContainerStyle={styles.libraryModes}>{([['all', 'Tümü'], ['favorites', '☆ Favoriler'], ['recent', '◷ Son izlenenler']] as [LibraryMode, string][]).map(([mode, label]) => <TouchableOpacity key={mode} style={[styles.modeChip, libraryMode === mode && styles.modeChipActive]} onPress={() => { setLibraryMode(mode); setGroup(null); setSeriesTitle(null); setSeriesSeason(null); setNavigationHistory([]); }}><Text style={[styles.modeChipText, libraryMode === mode && styles.modeChipTextActive]}>{label}</Text></TouchableOpacity>)}</ScrollView>;

  async function activatePlaylist(list: Playlist, notify = true) {
    const startedAt = Date.now();
    setAdding(true);
    if (notify) setMessage(`${list.name} yükleniyor…`);
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 25000);
      let response: Response;
      try { response = await fetch(list.url, { signal: controller.signal, headers: { Accept: 'application/vnd.apple.mpegurl, audio/x-mpegurl, text/plain, */*' } }); }
      finally { clearTimeout(timeout); }
      if (!response.ok) throw new Error(`Sunucu ${response.status} yanıtı verdi.`);
      const playlistSource = await response.text();
      const parsed = parseM3u(playlistSource);
      if (!parsed.length) throw new Error('Bu adreste okunabilir M3U içeriği bulunamadı.');
      const stat = { durationMs: Date.now() - startedAt, count: parsed.length };
      const nextStats = { ...playlistLoadStats, [list.id]: stat };
      setPlaylistLoadStats(nextStats);
      await AsyncStorage.setItem('getiptv.playlistLoadStats', JSON.stringify(nextStats));
      setItems(parsed); setActivePlaylistId(list.id); activePlaylistIdRef.current = list.id; setGuidePrograms({}); setGuideStatus('idle'); setUrl(list.url); setActive(null); setGroup(null); setSeriesTitle(null); setSeriesSeason(null); setNavigationHistory([]); setQuery(''); setLibraryMode('all');
      await AsyncStorage.setItem('getiptv.activePlaylist', list.id);
      const guideAddress = list.epgUrl || getPlaylistEpgUrl(list.url, playlistSource);
      setActiveGuideUrl(guideAddress || '');
      if (guideAddress) void refreshGuide(list.id, guideAddress);
      else setGuideStatus('unavailable');
      setMessage(`${parsed.length.toLocaleString('tr-TR')} içerik yüklendi · ${list.name}`);
      setShowLists(false);
      void refreshPlaylistExpiry(list);
      return true;
    } catch (error) {
      setMessage(error instanceof Error && error.name === 'AbortError' ? 'Yayın listesi 25 saniyede yanıt vermedi. Bağlantıyı kontrol edip yeniden dene.' : error instanceof Error ? error.message : 'Liste alınamadı. Bağlantıyı kontrol et.');
      return false;
    } finally { setAdding(false); }
  }

  async function refreshGuide(playlistId: string, address: string) {
    if (activePlaylistIdRef.current === playlistId) setGuideStatus('loading');
    const cacheKey = `getiptv.epg.${cacheKeyForPlaylist(playlistId)}`;
    try {
      const cached = await AsyncStorage.getItem(cacheKey);
      if (cached) {
        const parsedCache = JSON.parse(cached) as { updatedAt?: number; programs?: GuideMap };
        if (parsedCache.updatedAt && Date.now() - parsedCache.updatedAt < 60 * 60_000 && parsedCache.programs && activePlaylistIdRef.current === playlistId) {
          setGuidePrograms(parsedCache.programs);
          setGuideStatus(Object.keys(parsedCache.programs).length ? 'ready' : 'unavailable');
          return;
        }
      }
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 18_000);
      let response: Response;
      try { response = await fetch(address, { signal: controller.signal, headers: { Accept: 'application/xml, text/xml, */*' } }); }
      finally { clearTimeout(timeout); }
      if (!response.ok) throw new Error(`EPG sunucusu ${response.status} yanıtı verdi.`);
      const xml = await response.text();
      if (xml.length > 20 * 1024 * 1024) throw new Error('EPG dosyası çok büyük. Sağlayıcıdan daha küçük bir rehber iste.');
      const programs = parseXmltv(xml);
      if (!Object.keys(programs).length) throw new Error('EPG dosyasında güncel program bulunamadı.');
      if (activePlaylistIdRef.current !== playlistId) return;
      setGuidePrograms(programs);
      setGuideStatus('ready');
      await AsyncStorage.setItem(cacheKey, JSON.stringify({ updatedAt: Date.now(), programs }));
    } catch {
      if (activePlaylistIdRef.current === playlistId) {
        setGuidePrograms({});
        setGuideStatus('unavailable');
      }
    }
  }

  async function refreshPlaylistExpiry(list: Playlist) {
    const saveExpiry = async (expiry: PlaylistExpiry) => {
      const next = { ...playlistExpiriesRef.current, [list.id]: expiry };
      playlistExpiriesRef.current = next;
      setPlaylistExpiries(next);
      await AsyncStorage.setItem('getiptv.playlistExpiries', JSON.stringify(next));
    };
    try {
      const source = new URL(list.url);
      const expiryParam = [...source.searchParams.entries()].find(([key]) => /^(exp|exp_date|expires|expiry|expiration|valid_until)$/i.test(key))?.[1];
      if (expiryParam) {
        const numeric = Number(expiryParam);
        const parsed = Number.isFinite(numeric) && numeric > 0 ? (numeric < 100000000000 ? numeric * 1000 : numeric) : Date.parse(expiryParam);
        if (Number.isFinite(parsed) && parsed > 0) { await saveExpiry({ status: 'known', expiresAt: parsed }); return; }
      }
      const username = source.searchParams.get('username');
      const password = source.searchParams.get('password');
      if (!username || !password || !/\/get\.php$/i.test(source.pathname)) { await saveExpiry({ status: 'unknown' }); return; }
      await saveExpiry({ status: 'checking' });
      const api = new URL(source.toString());
      api.pathname = api.pathname.replace(/get\.php$/i, 'player_api.php');
      api.search = '';
      api.searchParams.set('username', username);
      api.searchParams.set('password', password);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      let response: Response;
      try { response = await fetch(api.toString(), { signal: controller.signal, headers: { Accept: 'application/json' } }); }
      finally { clearTimeout(timeout); }
      if (!response.ok) throw new Error('API yanıt vermedi');
      const data = await response.json() as { user_info?: { exp_date?: string | number | null } };
      if (!data.user_info || !Object.prototype.hasOwnProperty.call(data.user_info, 'exp_date')) throw new Error('Bitiş bilgisi yok');
      const rawExpiry = data.user_info.exp_date;
      if (rawExpiry === null || rawExpiry === '' || Number(rawExpiry) === 0) { await saveExpiry({ status: 'never' }); return; }
      const timestamp = Number(rawExpiry);
      if (!Number.isFinite(timestamp) || timestamp <= 0) throw new Error('Bitiş tarihi okunamadı');
      await saveExpiry({ status: 'known', expiresAt: timestamp < 100000000000 ? timestamp * 1000 : timestamp });
    } catch {
      await saveExpiry({ status: 'unavailable' });
    }
  }

  async function openItem(item: MediaItem, queue: MediaItem[] = visible, requestFullscreen = false) {
    setCurrent(item);
    setResumeAt(watchProgress[item.id]?.position || 0);
    if (queue.length) setPlayQueue(queue);
    if (requestFullscreen) {
      setFullscreenRequest((value) => value + 1);
      if (typeof document !== 'undefined') {
        const root = document.documentElement as HTMLElement & { webkitRequestFullscreen?: () => void };
        if (root.requestFullscreen) void root.requestFullscreen().catch(() => {});
        else root.webkitRequestFullscreen?.();
      }
    }
    const next = [item.id, ...recentIds.filter((id) => id !== item.id)].slice(0, 100);
    setRecentIds(next);
    await AsyncStorage.setItem('getiptv.recent', JSON.stringify(next));
  }

  function navigateTo(nextActive: Kind | null, nextGroup: string | null = null) {
    if (nextActive === active && nextGroup === group && seriesTitle === null && seriesSeason === null) return;
    if (nextActive === 'live' && active !== 'live') {
      const lastLive = recentIds.map((id) => items.find((item) => item.id === id)).find((item): item is MediaItem => Boolean(item?.kind === 'live'));
      if (lastLive) {
        setCurrent(lastLive);
        setResumeAt(0);
        setPlayQueue(items.filter((item) => item.kind === 'live'));
      }
    }
    setNavigationHistory((history) => [...history, { active, group, seriesTitle, seriesSeason }].slice(-40));
    setActive(nextActive);
    setGroup(nextGroup);
    setSeriesTitle(null);
    setSeriesSeason(null);
    setQuery('');
  }

  function openSeries(key: string) {
    setNavigationHistory((history) => [...history, { active, group, seriesTitle, seriesSeason }].slice(-40));
    setSeriesTitle(key);
    setSeriesSeason(null);
    setQuery('');
    setShowSeasonPicker(true);
  }

  function openSeason(season: number) {
    setSeriesSeason(season);
    setQuery('');
    setShowSeasonPicker(false);
  }

  function goBack() {
    if (current) { setCurrent(null); return; }
    const previous = navigationHistory[navigationHistory.length - 1];
    if (!previous) { setActive(null); setGroup(null); setSeriesTitle(null); setSeriesSeason(null); setQuery(''); return; }
    setNavigationHistory((history) => history.slice(0, -1));
    setActive(previous.active);
    setGroup(previous.group);
    setSeriesTitle(previous.seriesTitle);
    setSeriesSeason(previous.seriesSeason);
    setQuery('');
  }

  function goHome() {
    setNavigationHistory([]);
    setCurrent(null);
    setActive(null);
    setGroup(null);
    setSeriesTitle(null);
    setSeriesSeason(null);
    setQuery('');
  }

  function saveWatchProgress(item: MediaItem, position: number, duration: number) {
    if ((item.kind !== 'movies' && item.kind !== 'series') || !Number.isFinite(position) || position < 3) return;
    const next = { ...watchProgress };
    if (Number.isFinite(duration) && duration > 0 && position >= duration - 25) delete next[item.id];
    else next[item.id] = { position, duration: Number.isFinite(duration) ? duration : 0 };
    setWatchProgress(next);
    void AsyncStorage.setItem('getiptv.progress', JSON.stringify(next));
  }

  function restartCurrent() {
    if (!current) return;
    const next = { ...watchProgress };
    delete next[current.id];
    setWatchProgress(next);
    void AsyncStorage.setItem('getiptv.progress', JSON.stringify(next));
    setResumeAt(0);
  }

  async function toggleFavorite(item: MediaItem) {
    const next = favoriteIds.includes(item.id) ? favoriteIds.filter((id) => id !== item.id) : [item.id, ...favoriteIds];
    setFavoriteIds(next);
    await AsyncStorage.setItem('getiptv.favorites', JSON.stringify(next));
  }

  function stepPlayback(direction: -1 | 1) {
    const queue = playQueue.length ? playQueue : visible;
    if (queue.length < 2) return;
    const index = queue.findIndex((entry) => entry.id === current?.id);
    const nextIndex = ((index < 0 ? 0 : index) + direction + queue.length) % queue.length;
    void openItem(queue[nextIndex], queue);
  }

  function openAdd() {
    setMessage('');
    setAddMode('choose');
    setShowAdd(true);
  }

  async function saveAndLoadPlaylist(address: string, name: string, defaultLabel = 'Liste', guideAddress?: string) {
    const existing = savedPlaylists.find((list) => list.url === address);
    const list: Playlist = { id: address, name: name.trim() || existing?.name || `${defaultLabel} ${savedPlaylists.length + 1}`, url: address, epgUrl: guideAddress?.trim() || existing?.epgUrl };
    const nextLists = [list, ...savedPlaylists.filter((entry) => entry.url !== address)];
    setSavedPlaylists(nextLists);
    await AsyncStorage.setItem('getiptv.playlists', JSON.stringify(nextLists));
    await AsyncStorage.setItem('getiptv.playlistUrl', address);
    const loaded = await activatePlaylist(list);
    if (loaded) setShowAdd(false);
  }

  async function loadPlaylist() {
    const address = url.trim();
    if (!/^https?:\/\//i.test(address)) { setMessage('http:// veya https:// ile başlayan bir bağlantı gir.'); return; }
    await saveAndLoadPlaylist(address, playlistName, 'Liste', epgUrl.trim() || undefined);
  }

  async function loadXtreamPlaylist() {
    const server = xtreamServer.trim().replace(/\/+$/, '').replace(/\/(?:get|player_api)\.php$/i, '');
    if (!server || !xtreamUsername.trim() || !xtreamPassword.trim()) { setMessage('Sunucu adresi, kullanıcı adı ve şifre alanlarını doldur.'); return; }
    try {
      const parsed = new URL(server);
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Sunucu adresi http:// veya https:// ile başlamalı.');
      if (parsed.search || parsed.hash) throw new Error('Sunucu alanına yalnızca adresi yaz; kullanıcı adı ve şifreyi ayrı alanlara gir.');
      const base = `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
      const params = new URLSearchParams({ username: xtreamUsername.trim(), password: xtreamPassword, type: 'm3u_plus', output: xtreamOutput });
      await saveAndLoadPlaylist(`${base}/get.php?${params.toString()}`, playlistName, 'Xtream', epgUrl.trim() || undefined);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Sunucu adresini kontrol et.');
    }
  }

  if (initializing) return <SafeAreaView style={styles.startupLoading}><View style={[styles.brandMark, styles.brandMarkHome]}><Text style={[styles.brandGlyph, styles.brandGlyphHome]}>Ⅱ▶</Text></View><Text style={styles.startupTitle}>getIPTV</Text><View style={styles.startupSpinner}><ActivityIndicator color="#45D7B4" size="large" /><Text style={styles.startupSpinnerIcon}>▶</Text></View><Text style={styles.startupMessage}>İçerikler yükleniyor</Text><Text style={styles.startupDetail}>Yayın listen ve içeriklerin hazırlanıyor. Tamamlandığında ana sayfa açılacak.</Text></SafeAreaView>;

  if (current && !isWideLayout) return <StreamPlayer item={current} fullscreenRequest={fullscreenRequest} resumeAt={resumeAt} seriesNavigation={seriesPlaybackNavigation} onProgress={(position, duration) => saveWatchProgress(current, position, duration)} onRestart={restartCurrent} onClose={() => setCurrent(null)} onPrevious={() => stepPlayback(-1)} onNext={() => stepPlayback(1)} />;

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar barStyle="light-content" backgroundColor="#09111E" />
      <View style={[styles.header, active === null && styles.headerHome, active !== null && styles.headerLibrary]}>
        <TouchableOpacity accessibilityRole="button" accessibilityLabel="getIPTV ana sayfaya dön" activeOpacity={0.82} style={[styles.brandCluster, styles.brandClusterCentered]} onPress={goHome}>
          <View style={[styles.brandMark, active === null && styles.brandMarkHome]}><Text style={[styles.brandGlyph, active === null && styles.brandGlyphHome]}>Ⅱ▶</Text></View>
          <View><Text style={[styles.brand, active === null && styles.brandHome]}>getIPTV</Text><Text style={styles.tagline}>İzlemek istediğin her şey, tek bir yerde.</Text></View>
        </TouchableOpacity>
        {savedPlaylists.length ? <TouchableOpacity style={styles.headerLists} onPress={() => setShowLists(true)}><Text style={styles.headerListsText}>☷ Listeler</Text></TouchableOpacity> : null}
        <TouchableOpacity style={styles.addTop} onPress={openAdd}><Text style={styles.addTopText}>＋</Text></TouchableOpacity>
      </View>
      {active === null ? (
        <ScrollView contentContainerStyle={styles.home}>
          <Text style={styles.headline}>Ne izlemek istersin?</Text>
          <Text style={styles.deviceMac}>MAC adresi · mobil cihazda işletim sistemi tarafından gizleniyor</Text>
          {items.length ? <View style={styles.playlistInfo}>
            <Text style={styles.playlistInfoName} numberOfLines={1}>Yayın listesi: {activePlaylistName}</Text>
            <Text style={styles.playlistExpiry}>{expiryText}</Text>
            <Text style={styles.playlistInfoMeta}>{items.length.toLocaleString('tr-TR')} içerik · {adding ? 'liste yenileniyor…' : loadDurationText ? `son yükleme ${loadDurationText}` : 'yükleme süresi ölçülüyor'}</Text>
          </View> : null}
          {!items.length ? <Text style={styles.homeSub}>Başlamak için yayın listeni ekle.</Text> : null}
          <View style={[styles.sectionGrid, isWideLayout && styles.sectionGridWide, isCompactHome && styles.sectionGridCompact]}>
            {SECTIONS.map((section) => {
              const count = items.filter((item) => item.kind === section.id).length;
              return (
                <TouchableOpacity key={section.id} style={[styles.sectionCard, isWideLayout && styles.sectionCardWide, isCompactHome && styles.sectionCardCompact, { backgroundColor: PALETTE[section.id] }]} onPress={() => navigateTo(section.id)}>
                  <Text style={styles.sectionIcon}>{section.icon}</Text><Text style={styles.sectionTitle}>{section.title}</Text>
                  <Text style={styles.sectionSubtitle}>{section.subtitle}</Text><Text style={styles.sectionCount}>{count.toLocaleString('tr-TR')} içerik</Text>
                </TouchableOpacity>
              );
            })}
          </View>
          <TouchableOpacity style={styles.primaryButton} onPress={openAdd}><Text style={styles.primaryText}>{items.length ? '＋ Başka liste ekle' : '＋ Yayın listesi ekle'}</Text></TouchableOpacity>
          {savedPlaylists.length ? <TouchableOpacity style={styles.secondaryHomeButton} onPress={() => setShowLists(true)}><Text style={styles.secondaryHomeText}>☷ Listelerim · {savedPlaylists.length}</Text></TouchableOpacity> : null}
          <Text style={styles.freeNote}>Ücretsiz kullanım · Listelerin cihazında kalır</Text>
          {message ? <Text style={styles.message}>{message}</Text> : null}
        </ScrollView>
      ) : (
        <View style={[styles.library, isWideLayout && styles.libraryWide]}>
          <View style={styles.sectionRail}>
            {SECTIONS.map((section) => <TouchableOpacity key={section.id} accessibilityRole="button" accessibilityLabel={section.title} onHoverIn={() => setHoveredSection(section.id)} onHoverOut={() => setHoveredSection((value) => value === section.id ? null : value)} onFocus={() => setHoveredSection(section.id)} onBlur={() => setHoveredSection((value) => value === section.id ? null : value)} onPress={() => { if (section.id !== active) navigateTo(section.id); }} style={[styles.sectionRailButton, active === section.id && styles.sectionRailActive, hoveredSection === section.id && styles.sectionRailExpanded, { borderLeftColor: PALETTE[section.id] }]}><Text style={styles.sectionRailIcon}>{section.icon}</Text>{hoveredSection === section.id ? <Text style={styles.sectionRailLabel}>{section.title}</Text> : null}</TouchableOpacity>)}
            <View style={styles.railDivider} />
            {([
              ['home', '⌂', 'Ana sayfa', goHome],
              ['search', '⌕', 'Ara', () => searchInputRef.current?.focus()],
              ['lists', '☷', 'Listeler', () => setShowLists(true)],
              ['add', '＋', 'Liste ekle', openAdd],
              ['settings', '⚙', 'Ayarlar', () => setShowSettings(true)],
              ['about', 'ⓘ', 'Hakkında', () => setShowAbout(true)],
            ] as [string, string, string, () => void][]).map(([id, icon, label, action]) => <TouchableOpacity key={id} accessibilityRole="button" accessibilityLabel={label} title={label} onHoverIn={() => setHoveredRailAction(id)} onHoverOut={() => setHoveredRailAction((value) => value === id ? null : value)} onFocus={() => setHoveredRailAction(id)} onBlur={() => setHoveredRailAction((value) => value === id ? null : value)} onPress={action} style={[styles.sectionRailButton, styles.utilityRailButton, hoveredRailAction === id && styles.sectionRailExpanded]}><Text style={styles.sectionRailIcon}>{icon}</Text>{hoveredRailAction === id ? <Text style={styles.sectionRailLabel}>{label}</Text> : null}</TouchableOpacity>)}
          </View>
          <View style={styles.libraryTop}>
            <View style={styles.libraryNavButtons}>
              <TouchableOpacity accessibilityRole="button" accessibilityLabel="Bir adım geri git" title="Geri" onHoverIn={() => setHoveredNavAction('back')} onHoverOut={() => setHoveredNavAction(null)} style={[styles.navButton, styles.iconNavButton]} onPress={goBack}><Text style={styles.navButtonText}>←</Text>{hoveredNavAction === 'back' ? <Text style={styles.navTooltip}>Geri</Text> : null}</TouchableOpacity>
              <TouchableOpacity accessibilityRole="button" accessibilityLabel="Ana sayfaya git" title="Ana sayfa" onHoverIn={() => setHoveredNavAction('home')} onHoverOut={() => setHoveredNavAction(null)} style={[styles.navButton, styles.iconNavButton]} onPress={goHome}><Text style={styles.navButtonText}>⌂</Text>{hoveredNavAction === 'home' ? <Text style={styles.navTooltip}>Ana sayfa</Text> : null}</TouchableOpacity>
            </View>
            <Text style={styles.libraryHeading}>{SECTIONS.find((s) => s.id === active)?.title}</Text>
          </View>
          {isWideLayout ? (
            <View style={styles.libraryColumns}>
              <View style={styles.categoryPanel}>
                <Text style={styles.panelHeading}>KATEGORİLER</Text>
                <TouchableOpacity style={[styles.groupOption, !group && styles.groupOptionActive]} onPress={() => navigateTo(active, null)}><Text style={styles.groupOptionName}>Tüm alt kategoriler</Text><Text style={styles.groupOptionCount}>{groupCount(null).toLocaleString('tr-TR')}</Text></TouchableOpacity>
                {(active === 'movies' || active === 'series') ? <TouchableOpacity style={[styles.groupOption, group === CONTINUE_GROUP && styles.groupOptionActive]} onPress={() => navigateTo(active, CONTINUE_GROUP)}><Text style={styles.groupOptionName}>İzlemeye devam et</Text><Text style={styles.groupOptionCount}>{activeContinueItems.length.toLocaleString('tr-TR')}</Text></TouchableOpacity> : null}
                <FlatList data={groups} keyExtractor={(name) => name} contentContainerStyle={styles.groupOptions} renderItem={({ item: name }) => <TouchableOpacity style={[styles.groupOption, group === name && styles.groupOptionActive]} onPress={() => navigateTo(active, name)}><Text style={styles.groupOptionName} numberOfLines={2}>{name}</Text><Text style={styles.groupOptionCount}>{groupCount(name).toLocaleString('tr-TR')}</Text></TouchableOpacity>} />
              </View>
              <View style={[styles.playlistPanel, current && styles.playlistPanelWithPlayer]}>
                <View style={styles.playlistHeadingRow}><Text style={styles.panelHeading}>{isSeriesBrowse ? seriesHeading : 'YAYIN LİSTESİ'}</Text><Text style={styles.groupPickerCount}>{isSeriesBrowse ? seriesCountText : `${visible.length.toLocaleString('tr-TR')} yayın`}</Text></View>
                {renderLibraryModes()}
                <TextInput ref={searchInputRef} value={query} onChangeText={setQuery} placeholder="Yayın ara…" placeholderTextColor="#8BA0B5" style={styles.search} />
                {renderGuideStatus()}
                {contentList}
              </View>
              {current ? <StreamPlayer item={current} fullscreenRequest={fullscreenRequest} resumeAt={resumeAt} seriesNavigation={seriesPlaybackNavigation} onProgress={(position, duration) => saveWatchProgress(current, position, duration)} onRestart={restartCurrent} onClose={() => setCurrent(null)} onPrevious={() => stepPlayback(-1)} onNext={() => stepPlayback(1)} compact /> : null}
            </View>
          ) : (
            <>
              <TextInput ref={searchInputRef} value={query} onChangeText={setQuery} placeholder="İçerik ara…" placeholderTextColor="#8BA0B5" style={styles.search} />
              {renderLibraryModes()}
              {renderGuideStatus()}
            <TouchableOpacity accessibilityRole="button" style={styles.groupPickerButton} onPress={() => { setGroupSearch(''); setShowGroupPicker(true); }}>
                <View style={{ flex: 1 }}><Text style={styles.groupPickerLabel}>ALT KATEGORİ</Text><Text style={styles.groupPickerValue} numberOfLines={1}>{group || 'Tüm alt kategoriler'}</Text></View>
                <Text style={styles.groupPickerCount}>{groupCount(group).toLocaleString('tr-TR')} yayın　⌄</Text>
              </TouchableOpacity>
              {contentList}
            </>
          )}
        </View>
      )}
      <Modal visible={showAdd} animationType="slide" transparent onRequestClose={() => setShowAdd(false)}>
        <View style={styles.modalShade}><View style={[styles.modalCard, styles.addModalCard]}>
          <View style={styles.modalHeader}>
            <View style={{ flex: 1 }}>
              {addMode !== 'choose' ? <TouchableOpacity onPress={() => { setAddMode('choose'); setMessage(''); }}><Text style={styles.addBack}>‹ Kaynak seç</Text></TouchableOpacity> : null}
              <Text style={styles.modalTitle}>{addMode === 'choose' ? 'Yayın listesi ekle' : addMode === 'm3u' ? 'M3U bağlantısı' : 'Xtream Codes'}</Text>
              <Text style={styles.modalSub}>{addMode === 'choose' ? 'Liste türünü seç' : addMode === 'm3u' ? 'Sağlayıcının verdiği tam M3U adresini gir.' : 'Sağlayıcının verdiği sunucu ve hesap bilgilerini gir.'}</Text>
            </View>
            <TouchableOpacity onPress={() => setShowAdd(false)}><Text style={styles.close}>×</Text></TouchableOpacity>
          </View>
          <ScrollView style={styles.addFormScroll} keyboardShouldPersistTaps="handled" contentContainerStyle={styles.addFormContent}>
            {addMode === 'choose' ? <View style={styles.addMethods}>
              <TouchableOpacity style={styles.addMethodCard} onPress={() => { setMessage(''); setAddMode('m3u'); }}>
                <Text style={styles.addMethodIcon}>↗</Text><View style={{ flex: 1 }}><Text style={styles.addMethodTitle}>M3U bağlantısı</Text><Text style={styles.addMethodSub}>Elindeki tam M3U/M3U8 URL’sini kullan.</Text></View><Text style={styles.addMethodChevron}>›</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.addMethodCard} onPress={() => { setMessage(''); setAddMode('xtream'); }}>
                <Text style={styles.addMethodIcon}>▤</Text><View style={{ flex: 1 }}><Text style={styles.addMethodTitle}>Xtream Codes</Text><Text style={styles.addMethodSub}>Sunucu, kullanıcı adı ve şifre ile bağlan.</Text></View><Text style={styles.addMethodChevron}>›</Text>
              </TouchableOpacity>
              <Text style={styles.freeNote}>Yalnızca erişim iznin olan yayın listelerini ekle.</Text>
            </View> : null}
            {addMode === 'm3u' ? <>
              <TextInput value={playlistName} onChangeText={setPlaylistName} placeholder="Liste adı (isteğe bağlı)" placeholderTextColor="#8BA0B5" style={styles.input} />
              <TextInput value={url} onChangeText={setUrl} placeholder="http:// veya https://…" placeholderTextColor="#8BA0B5" style={[styles.input, styles.urlInput]} autoCapitalize="none" autoCorrect={false} keyboardType="url" />
              <TextInput value={epgUrl} onChangeText={setEpgUrl} placeholder="EPG/XMLTV adresi (isteğe bağlı)" placeholderTextColor="#8BA0B5" style={styles.input} autoCapitalize="none" autoCorrect={false} keyboardType="url" />
              <Text style={styles.xtreamHelp}>M3U başlığında rehber adresi varsa otomatik kullanılır. Sağlayıcın ayrı bir XMLTV adresi verdiyse buraya ekleyebilirsin.</Text>
              {message ? <Text style={styles.message}>{message}</Text> : null}
              <TouchableOpacity disabled={adding} style={[styles.primaryButton, adding && { opacity: 0.7 }]} onPress={loadPlaylist}>{adding ? <ActivityIndicator color="#06201A" /> : <Text style={styles.primaryText}>M3U listesini yükle</Text>}</TouchableOpacity>
            </> : null}
            {addMode === 'xtream' ? <>
              <TextInput value={xtreamServer} onChangeText={setXtreamServer} placeholder="Sunucu adresi · https://ornek:8080" placeholderTextColor="#8BA0B5" style={styles.input} autoCapitalize="none" autoCorrect={false} keyboardType="url" />
              <TextInput value={xtreamUsername} onChangeText={setXtreamUsername} placeholder="Kullanıcı adı" placeholderTextColor="#8BA0B5" style={styles.input} autoCapitalize="none" autoCorrect={false} textContentType="username" />
              <TextInput value={xtreamPassword} onChangeText={setXtreamPassword} placeholder="Şifre" placeholderTextColor="#8BA0B5" style={styles.input} autoCapitalize="none" autoCorrect={false} secureTextEntry textContentType="password" />
              <TextInput value={playlistName} onChangeText={setPlaylistName} placeholder="Liste adı (isteğe bağlı)" placeholderTextColor="#8BA0B5" style={styles.input} />
              <TextInput value={epgUrl} onChangeText={setEpgUrl} placeholder="EPG/XMLTV adresi (isteğe bağlı)" placeholderTextColor="#8BA0B5" style={styles.input} autoCapitalize="none" autoCorrect={false} keyboardType="url" />
              <Text style={styles.outputLabel}>Yayın biçimi</Text>
              <View style={styles.outputOptions}>
                {([['m3u8', 'M3U8 · Önerilen'], ['ts', 'TS · Alternatif']] as [XtreamOutput, string][]).map(([value, label]) => <TouchableOpacity key={value} style={[styles.outputOption, xtreamOutput === value && styles.outputOptionActive]} onPress={() => setXtreamOutput(value)}><Text style={[styles.outputOptionText, xtreamOutput === value && styles.outputOptionTextActive]}>{label}</Text></TouchableOpacity>)}
              </View>
              <Text style={styles.xtreamHelp}>Bu bilgilerle M3U+ listesi oluşturup içeri alırım. HTTPS varsa onu kullan; bağlantı bilgileri bu tarayıcı/cihazda kayıtlı liste adresinde saklanır.</Text>
              {message ? <Text style={styles.message}>{message}</Text> : null}
              <TouchableOpacity disabled={adding} style={[styles.primaryButton, adding && { opacity: 0.7 }]} onPress={loadXtreamPlaylist}>{adding ? <ActivityIndicator color="#06201A" /> : <Text style={styles.primaryText}>Xtream listesini yükle</Text>}</TouchableOpacity>
            </> : null}
          </ScrollView>
        </View></View>
      </Modal>
      <Modal visible={showGuideEditor} animationType="fade" transparent onRequestClose={() => setShowGuideEditor(false)}>
        <View style={styles.modalShade}><View style={[styles.modalCard, styles.quickModal]}>
          <View style={styles.modalHeader}><View style={{ flex: 1 }}><Text style={styles.modalTitle}>Yayın rehberi (EPG)</Text><Text style={styles.modalSub}>Sağlayıcının verdiği XMLTV bağlantısını ekle.</Text></View><TouchableOpacity onPress={() => setShowGuideEditor(false)}><Text style={styles.close}>×</Text></TouchableOpacity></View>
          <TextInput value={guideEditValue} onChangeText={setGuideEditValue} placeholder="https://…/xmltv.php?..." placeholderTextColor="#8BA0B5" style={styles.input} autoCapitalize="none" autoCorrect={false} keyboardType="url" />
          <Text style={styles.xtreamHelp}>Rehber yalnızca sağlayıcı EPG verisi sunuyorsa çalışır. Yayın adlarıyla eşleşme için M3U içindeki tvg-id bilgileri kullanılır.</Text>
          <TouchableOpacity style={styles.primaryButton} onPress={async () => {
            const address = guideEditValue.trim();
            if (!/^https?:\/\//i.test(address)) { setMessage('EPG adresi http:// veya https:// ile başlamalı.'); return; }
            const currentList = savedPlaylists.find((entry) => entry.id === activePlaylistId);
            if (!currentList) { setMessage('Önce bir yayın listesi seç.'); return; }
            const updated = { ...currentList, epgUrl: address };
            const nextLists = savedPlaylists.map((entry) => entry.id === currentList.id ? updated : entry);
            setSavedPlaylists(nextLists);
            await AsyncStorage.setItem('getiptv.playlists', JSON.stringify(nextLists));
            await AsyncStorage.removeItem(`getiptv.epg.${cacheKeyForPlaylist(currentList.id)}`);
            setActiveGuideUrl(address);
            setShowGuideEditor(false);
            void refreshGuide(currentList.id, address);
          }}><Text style={styles.primaryText}>Kaydet ve rehberi yükle</Text></TouchableOpacity>
        </View></View>
      </Modal>
      <Modal visible={showLists} animationType="slide" transparent onRequestClose={() => setShowLists(false)}>
        <View style={styles.modalShade}><View style={[styles.modalCard, styles.groupPickerModal]}>
          <View style={styles.modalHeader}><View><Text style={styles.modalTitle}>Yayın listelerim</Text><Text style={styles.modalSub}>Kaydedilmiş kaynaklar bu cihazda tutulur.</Text></View><TouchableOpacity onPress={() => setShowLists(false)}><Text style={styles.close}>×</Text></TouchableOpacity></View>
          <ScrollView contentContainerStyle={styles.groupOptions}>
            {savedPlaylists.map((list) => <TouchableOpacity key={list.id} style={[styles.groupOption, activePlaylistId === list.id && styles.groupOptionActive]} onPress={() => { void activatePlaylist(list); }}>
              <View style={{ flex: 1 }}><Text style={styles.groupOptionName} numberOfLines={1}>{list.name}</Text><Text style={styles.channelGroup}>{activePlaylistId === list.id ? 'Şu anda açık' : 'Yüklemek için dokun'}</Text></View><Text style={styles.groupOptionCount}>{activePlaylistId === list.id ? '✓' : '›'}</Text>
            </TouchableOpacity>)}
            {!savedPlaylists.length ? <Text style={styles.empty}>Henüz kaydedilmiş liste yok.</Text> : null}
          </ScrollView>
          <TouchableOpacity style={styles.primaryButton} onPress={() => { setShowLists(false); openAdd(); }}><Text style={styles.primaryText}>＋ Yeni liste ekle</Text></TouchableOpacity>
        </View></View>
      </Modal>
      <Modal visible={showGroupPicker} animationType="slide" transparent onRequestClose={() => setShowGroupPicker(false)}>
        <View style={styles.modalShade}><View style={[styles.modalCard, styles.groupPickerModal]}>
          <View style={styles.modalHeader}><View><Text style={styles.modalTitle}>Alt kategori seç</Text><Text style={styles.modalSub}>{groups.length.toLocaleString('tr-TR')} kategori</Text></View><TouchableOpacity onPress={() => setShowGroupPicker(false)}><Text style={styles.close}>×</Text></TouchableOpacity></View>
          <TextInput value={groupSearch} onChangeText={setGroupSearch} placeholder="Kategori ara…" placeholderTextColor="#8BA0B5" style={styles.input} />
          <FlatList
            data={[...((active === 'movies' || active === 'series') ? [CONTINUE_GROUP] : []), null, ...matchingGroups]}
            keyExtractor={(name) => name ?? '__all__'}
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={styles.groupOptions}
            ListEmptyComponent={<Text style={styles.empty}>Eşleşen kategori bulunamadı.</Text>}
            renderItem={({ item: name }) => <TouchableOpacity style={[styles.groupOption, group === name && styles.groupOptionActive]} onPress={() => { navigateTo(active, name); setShowGroupPicker(false); setGroupSearch(''); }}>
              <Text style={styles.groupOptionName} numberOfLines={1}>{name === CONTINUE_GROUP ? 'İzlemeye devam et' : name || 'Tüm alt kategoriler'}</Text><Text style={styles.groupOptionCount}>{groupCount(name).toLocaleString('tr-TR')}</Text>
            </TouchableOpacity>}
          />
        </View></View>
      </Modal>
      <Modal visible={showSettings} animationType="fade" transparent onRequestClose={() => setShowSettings(false)}>
        <View style={styles.modalShade}><View style={styles.quickModal}>
          <View style={styles.modalHeader}><View><Text style={styles.modalTitle}>Ayarlar</Text><Text style={styles.modalSub}>getIPTV tercihleri</Text></View><TouchableOpacity accessibilityLabel="Kapat" onPress={() => setShowSettings(false)}><Text style={styles.close}>×</Text></TouchableOpacity></View>
          <Text style={styles.quickInfoTitle}>Görünüm</Text><Text style={styles.quickInfoText}>Ekran düzeni cihazının boyutuna göre otomatik ayarlanır.</Text>
          <Text style={styles.quickInfoTitle}>Veriler</Text><Text style={styles.quickInfoText}>Yayın listelerin ve izleme geçmişin bu cihazda saklanır.</Text>
          <TouchableOpacity style={styles.groupOption} onPress={() => { setShowSettings(false); setShowLists(true); }}><Text style={styles.groupOptionName}>Yayın listelerini yönet</Text><Text style={styles.groupOptionCount}>›</Text></TouchableOpacity>
        </View></View>
      </Modal>
      <Modal visible={showAbout} animationType="fade" transparent onRequestClose={() => setShowAbout(false)}>
        <View style={styles.modalShade}><View style={styles.quickModal}>
          <View style={styles.modalHeader}><View><Text style={styles.modalTitle}>getIPTV hakkında</Text><Text style={styles.modalSub}>İzlemek istediğin her şey, tek bir yerde.</Text></View><TouchableOpacity accessibilityLabel="Kapat" onPress={() => setShowAbout(false)}><Text style={styles.close}>×</Text></TouchableOpacity></View>
          <Text style={styles.quickInfoText}>getIPTV, kendi yayın listelerini tek yerde düzenleyip izlemene yardımcı olur. Listeler cihazında tutulur.</Text>
        </View></View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  startupLoading: { flex: 1, minHeight: '100%', alignItems: 'center', justifyContent: 'center', padding: 24, backgroundColor: '#09111E' }, startupTitle: { color: '#F4F7FC', fontSize: 30, fontWeight: '900', marginTop: 12 }, startupSpinner: { width: 48, height: 48, marginTop: 26, alignItems: 'center', justifyContent: 'center' }, startupSpinnerIcon: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, color: '#69E6C5', fontSize: 13, lineHeight: 48, textAlign: 'center', textAlignVertical: 'center', includeFontPadding: false, fontWeight: '900', zIndex: 1 }, startupMessage: { color: '#F4F7FC', fontSize: 19, fontWeight: '800', marginTop: 20 }, startupDetail: { color: '#A9BCD1', fontSize: 14, textAlign: 'center', marginTop: 8, maxWidth: 420 },
  safe: { flex: 1, backgroundColor: '#09111E' },
  header: { minHeight: 64, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 18, paddingTop: 10, paddingBottom: 12, gap: 11 }, headerHome: { minHeight: 82, paddingTop: 14, paddingBottom: 14 },
  headerLibrary: { justifyContent: 'flex-end', position: 'relative' }, brandCluster: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 11 }, brandClusterCentered: { position: 'absolute', left: '50%', width: 270, marginLeft: -135, justifyContent: 'center', flex: undefined, zIndex: 2, elevation: 2 },
  brandMark: { width: 54, height: 46, borderRadius: 14, backgroundColor: '#10283A', borderWidth: 1, borderColor: '#31546B', alignItems: 'center', justifyContent: 'center' }, brandMarkHome: { width: 66, height: 56, borderRadius: 17, borderColor: '#45D7B4' },
  brandGlyph: { color: '#4CDBB7', fontSize: 18, fontWeight: '900' }, brandGlyphHome: { fontSize: 22 }, brand: { color: '#F4F7FC', fontSize: 34, fontWeight: '900' }, brandHome: { fontSize: 40 },
  tagline: { color: '#9FB4CA', fontSize: 11, marginTop: 2 }, addTop: { width: 42, height: 42, borderRadius: 13, backgroundColor: '#45D7B4', alignItems: 'center', justifyContent: 'center', zIndex: 4, elevation: 4 },
  addTopText: { color: '#06221D', fontSize: 26, fontWeight: '700', marginTop: -2 },
  headerLists: { minHeight: 40, paddingHorizontal: 12, borderRadius: 12, justifyContent: 'center', backgroundColor: '#142437', borderWidth: 1, borderColor: '#2B4055', zIndex: 4, elevation: 4 }, headerListsText: { color: '#E8EFF7', fontSize: 12, fontWeight: '800' },
  home: { paddingHorizontal: 18, paddingTop: 16, paddingBottom: 36 },
  headline: { color: '#F4F7FC', fontSize: 28, fontWeight: '900', textAlign: 'center', marginTop: 12 }, homeSub: { color: '#A9BCD1', fontSize: 14, textAlign: 'center', marginTop: 8, marginBottom: 22 },
  deviceMac: { color: '#A9BCD1', fontSize: 11, textAlign: 'center', marginTop: 9 },
  playlistInfo: { alignSelf: 'stretch', width: '100%', flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'center', columnGap: 18, rowGap: 4, marginTop: 8, marginBottom: 18, paddingHorizontal: 16, paddingVertical: 9, borderRadius: 12, backgroundColor: '#101D2B', borderWidth: 1, borderColor: '#2B4055' },
  playlistInfoName: { color: '#EAF1F8', fontSize: 13, fontWeight: '900' }, playlistExpiry: { color: '#70E2C4', fontSize: 12, fontWeight: '800' }, playlistInfoMeta: { color: '#91A8BE', fontSize: 11 },
  sectionGrid: { gap: 13 }, sectionGridWide: { flexDirection: 'row', alignItems: 'stretch', justifyContent: 'space-between' }, sectionGridCompact: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between' }, sectionCard: { borderRadius: 20, paddingHorizontal: 20, paddingVertical: 17, minHeight: 124, borderWidth: 1, borderColor: '#FFFFFF35' }, sectionCardWide: { flex: 1, minWidth: 0 }, sectionCardCompact: { flexBasis: '48%', minHeight: 128, paddingHorizontal: 14 },
  sectionIcon: { color: '#FFF', fontSize: 25, fontWeight: '700' }, sectionTitle: { color: '#FFF', fontSize: 21, fontWeight: '900', marginTop: 5 },
  sectionSubtitle: { color: '#F7F4F8', fontSize: 12, fontWeight: '600', marginTop: 2 }, sectionCount: { color: '#FFFFFFD0', fontSize: 11, fontWeight: '700', marginTop: 8 },
  primaryButton: { minHeight: 52, backgroundColor: '#48D7B4', borderRadius: 15, alignItems: 'center', justifyContent: 'center', marginTop: 20, paddingHorizontal: 18 },
  secondaryHomeButton: { minHeight: 46, alignItems: 'center', justifyContent: 'center', borderRadius: 14, marginTop: 10, backgroundColor: '#142437', borderWidth: 1, borderColor: '#2B4055' }, secondaryHomeText: { color: '#E8EFF7', fontSize: 14, fontWeight: '800' },
  continueSection: { marginTop: 24 }, continueHeading: { color: '#F4F7FC', fontSize: 19, fontWeight: '900', marginBottom: 10 }, continueRow: { gap: 10, paddingRight: 18 },
  continueCard: { width: 220, minHeight: 104, padding: 13, borderRadius: 14, backgroundColor: '#111E2D', borderWidth: 1, borderColor: '#2B4055' }, continueName: { color: '#F4F7FC', fontSize: 14, fontWeight: '800' }, continueMeta: { color: '#91A8BE', fontSize: 11, marginTop: 5 }, continuePosition: { color: '#62DCC0', fontSize: 11, fontWeight: '700', marginTop: 10 },
  primaryText: { color: '#06221D', fontWeight: '900', fontSize: 15 }, freeNote: { textAlign: 'center', color: '#7891A8', fontSize: 11, lineHeight: 17, marginTop: 14 }, message: { color: '#FFD28A', fontSize: 12, textAlign: 'center', marginTop: 12, lineHeight: 18 },
  library: { flex: 1, paddingHorizontal: 16, paddingLeft: 62, position: 'relative' }, libraryTop: { minHeight: 76, paddingTop: 8, paddingBottom: 12, alignItems: 'center', position: 'relative' }, libraryNavButtons: { flexDirection: 'row', alignItems: 'center', gap: 8, position: 'absolute', left: 0, top: 8 }, navButton: { minHeight: 34, justifyContent: 'center', paddingHorizontal: 12, borderRadius: 10, backgroundColor: '#112332', borderWidth: 1, borderColor: '#31546B' }, iconNavButton: { width: 38, height: 36, paddingHorizontal: 0, alignItems: 'center', position: 'relative' }, navTooltip: { position: 'absolute', zIndex: 30, left: 42, top: 2, paddingHorizontal: 10, paddingVertical: 8, borderRadius: 8, overflow: 'hidden', backgroundColor: '#102332', color: '#F4F7FC', fontSize: 12, fontWeight: '700', minWidth: 58 }, navButtonText: { color: '#52DDBB', fontSize: 18, fontWeight: '900' }, libraryHeading: { color: '#F4F7FC', fontSize: 32, fontWeight: '900', textAlign: 'center', marginTop: 36 },
  sectionRail: { position: 'absolute', zIndex: 25, left: -60, top: 148, width: 42, gap: 7 }, sectionRailButton: { width: 42, minHeight: 42, flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-start', gap: 6, paddingHorizontal: 7, borderRadius: 12, borderLeftWidth: 3, backgroundColor: '#101D2B', borderWidth: 1, borderColor: '#263A4E', overflow: 'visible' }, sectionRailActive: { backgroundColor: '#173D37', borderColor: '#45D7B4' }, sectionRailExpanded: { width: 132, zIndex: 40, elevation: 8 }, utilityRailButton: { borderLeftColor: '#456078' }, railDivider: { width: 34, height: 1, marginVertical: 3, backgroundColor: '#294157' }, sectionRailIcon: { width: 20, textAlign: 'center', color: '#E6F5F2', fontSize: 18, fontWeight: '900' }, sectionRailLabel: { color: '#F4F7FC', fontSize: 12, fontWeight: '800', flexShrink: 0 },
  libraryWide: { maxWidth: 1500, width: '100%', alignSelf: 'center' }, libraryColumns: { flex: 1, flexDirection: 'row', gap: 14, minHeight: 0 },
  categoryPanel: { width: 290, flexShrink: 0, minHeight: 0, padding: 12, borderRadius: 16, borderWidth: 1, borderColor: '#263A4E', backgroundColor: '#0D1825' },
  playlistPanel: { flex: 1, minWidth: 0, minHeight: 0, padding: 12, borderRadius: 16, borderWidth: 1, borderColor: '#263A4E', backgroundColor: '#0D1825' },
  playlistPanelWithPlayer: { flexGrow: 0, flexShrink: 0, flexBasis: 360, width: 360 },
  inlinePlayer: { flexGrow: 0, flexShrink: 1, flexBasis: '42%', minWidth: 360, maxWidth: 760, minHeight: 0, padding: 12, borderRadius: 16, borderWidth: 1, borderColor: '#263A4E', backgroundColor: '#050910' },
  inlinePlayerHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 38, marginBottom: 8 },
  inlineBackButton: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 9, backgroundColor: '#112332', borderWidth: 1, borderColor: '#31546B' },
  inlineVideoFrame: { width: '100%', aspectRatio: 16 / 9, maxHeight: '68%', backgroundColor: '#000', justifyContent: 'center', overflow: 'hidden', borderRadius: 10 },
  panelHeading: { color: '#A9BCD1', fontSize: 11, fontWeight: '900', letterSpacing: 1.4, paddingHorizontal: 3, paddingVertical: 8 },
  playlistHeadingRow: { minHeight: 30, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 },
  backText: { color: '#52DDBB', fontSize: 14, fontWeight: '800' }, search: { height: 48, flexShrink: 0, borderRadius: 13, borderWidth: 1, borderColor: '#2B4055', backgroundColor: '#111E2D', color: '#F4F7FC', paddingHorizontal: 14, fontSize: 15 },
  libraryModesScroll: { height: 48, flexGrow: 0, flexShrink: 0, marginBottom: 8 }, libraryModes: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 2 }, modeChip: { minHeight: 34, paddingHorizontal: 13, alignItems: 'center', justifyContent: 'center', borderRadius: 18, backgroundColor: '#111E2D', borderWidth: 1, borderColor: '#2B4055' }, modeChipActive: { backgroundColor: '#174338', borderColor: '#45D7B4' }, modeChipText: { color: '#B8C8D7', fontSize: 12, fontWeight: '700' }, modeChipTextActive: { color: '#69E6C5' },
  guideStatusRow: { minHeight: 30, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 6, marginBottom: 4, paddingHorizontal: 10, borderRadius: 9, backgroundColor: '#101D2B' }, guideStatusText: { color: '#A9BCD1', fontSize: 11, fontWeight: '700', flex: 1 }, guideStatusReady: { color: '#69E6C5' }, guideActions: { flexDirection: 'row', alignItems: 'center' }, guideRetry: { color: '#70BFFF', fontSize: 11, fontWeight: '800', paddingVertical: 7, paddingHorizontal: 8 },
  groupPickerButton: { minHeight: 62, flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 10, marginBottom: 8, paddingHorizontal: 14, paddingVertical: 9, borderRadius: 14, borderWidth: 1, borderColor: '#2B4055', backgroundColor: '#111E2D' },
  groupPickerLabel: { color: '#8BA0B5', fontSize: 9, fontWeight: '800', letterSpacing: 1.4 }, groupPickerValue: { color: '#F4F7FC', fontSize: 14, fontWeight: '800', marginTop: 3 }, groupPickerCount: { color: '#71E7CA', fontSize: 11, fontWeight: '700' },
  groupPickerModal: { height: '82%', paddingBottom: 18 }, groupOptions: { paddingBottom: 12 },
  groupOption: { minHeight: 50, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, paddingHorizontal: 14, paddingVertical: 10, marginBottom: 7, borderRadius: 12, backgroundColor: '#0B1522', borderWidth: 1, borderColor: '#263A4E' },
  groupOptionActive: { backgroundColor: '#174338', borderColor: '#45D7B4' }, groupOptionName: { color: '#E8EFF7', fontSize: 14, fontWeight: '700', flex: 1 }, groupOptionCount: { color: '#8BA0B5', fontSize: 12, fontWeight: '700' }, channelList: { paddingBottom: 26 },
  channel: { minHeight: 68, flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 10, marginBottom: 8, borderRadius: 14, backgroundColor: '#121F2E', borderWidth: 1, borderColor: '#1D3043' }, channelWithPoster: { minHeight: 92, paddingVertical: 8 }, channelWithGuide: { minHeight: 88, paddingVertical: 7, borderColor: '#25433F' }, channelMain: { flex: 1, minWidth: 0, minHeight: 66, flexDirection: 'row', alignItems: 'center', gap: 12 }, favoriteButton: { width: 32, height: 44, alignItems: 'center', justifyContent: 'center' }, favoriteGlyph: { color: '#7891A8', fontSize: 21 }, favoriteActive: { color: '#FFD166' }, posterArtwork: { width: 50, height: 72, borderRadius: 8 }, artworkImage: { ...StyleSheet.absoluteFillObject, width: '100%', height: '100%', borderRadius: 10 },
  seriesFolderCard: { minHeight: 92, flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 9, padding: 12, borderRadius: 14, backgroundColor: '#111E2D', borderWidth: 1, borderColor: '#294157' }, seriesFolderIcon: { width: 50, height: 72, borderRadius: 9, alignItems: 'center', justifyContent: 'center', backgroundColor: '#7046C555', overflow: 'hidden' }, seriesFolderGlyph: { color: '#9DE7D7', fontSize: 21, fontWeight: '900' }, seriesFolderTitle: { color: '#F4F7FC', fontSize: 15, fontWeight: '900' }, seriesFolderCount: { color: '#67DCC0', fontSize: 12, fontWeight: '800' },
  seriesEpisodePane: { flex: 1, minHeight: 0 }, seasonSelectButton: { minHeight: 56, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginHorizontal: 4, marginBottom: 10, paddingHorizontal: 14, borderRadius: 13, backgroundColor: '#17283A', borderWidth: 1, borderColor: '#45D7B4' }, seasonSelectLabel: { color: '#8FA8BF', fontSize: 10, fontWeight: '900', letterSpacing: 1.2 }, seasonSelectValue: { color: '#F4F7FC', fontSize: 15, fontWeight: '900', marginTop: 3 }, seasonInlineList: { height: 196, maxHeight: 196, flexGrow: 0, marginHorizontal: 4, marginBottom: 10, padding: 0, backgroundColor: 'transparent' }, seasonInlineOption: { minHeight: 43, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 12, borderRadius: 9 }, seasonInlineOptionActive: { backgroundColor: '#173D37' }, seasonInlineName: { color: '#F4F7FC', fontSize: 13, fontWeight: '800' }, seasonInlineCount: { color: '#73DCC1', fontSize: 12, fontWeight: '700' },
  channelLogo: { width: 42, height: 42, borderRadius: 12, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }, channelLogoText: { color: '#71E7CA', fontWeight: '900' },
  channelName: { color: '#F4F7FC', fontSize: 14, fontWeight: '700' }, channelGroup: { color: '#91A8BE', fontSize: 11, marginTop: 4 }, channelProgram: { color: '#DDF5EE', fontSize: 11, fontWeight: '800', marginTop: 5 }, programLiveDot: { color: '#4BE0AE' }, channelNext: { color: '#8FA8BF', fontSize: 10, marginTop: 2 }, playIcon: { color: '#48D7B4', fontSize: 16, paddingHorizontal: 7 }, empty: { color: '#A9BCD1', textAlign: 'center', paddingTop: 35, fontSize: 14 },
  modalShade: { flex: 1, backgroundColor: '#0009', justifyContent: 'flex-end' }, modalCard: { backgroundColor: '#111D2C', borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 22, paddingBottom: 34, borderWidth: 1, borderColor: '#294157' }, quickModal: { width: '92%', maxWidth: 480, alignSelf: 'center', marginBottom: 24, padding: 22, borderRadius: 20, backgroundColor: '#111D2C', borderWidth: 1, borderColor: '#45D7B4' }, quickInfoTitle: { color: '#F4F7FC', fontSize: 15, fontWeight: '900', marginTop: 8 }, quickInfoText: { color: '#A9BCD1', fontSize: 14, lineHeight: 21, marginTop: 5, marginBottom: 10 },
  addModalCard: { maxHeight: '92%', paddingBottom: 18 }, addFormScroll: { flexShrink: 1 }, addFormContent: { paddingBottom: 10 }, addMethods: { gap: 10 },
  addBack: { color: '#52DDBB', fontSize: 13, fontWeight: '800', marginBottom: 8 },
  addMethodCard: { minHeight: 78, flexDirection: 'row', alignItems: 'center', gap: 14, padding: 14, borderRadius: 14, backgroundColor: '#0B1522', borderWidth: 1, borderColor: '#2B4055' },
  addMethodIcon: { width: 38, height: 38, lineHeight: 38, textAlign: 'center', color: '#69E6C5', fontSize: 20, fontWeight: '900', borderRadius: 11, backgroundColor: '#174338' },
  addMethodTitle: { color: '#F4F7FC', fontSize: 15, fontWeight: '900' }, addMethodSub: { color: '#91A8BE', fontSize: 12, marginTop: 4 }, addMethodChevron: { color: '#69E6C5', fontSize: 24 },
  outputLabel: { color: '#A9BCD1', fontSize: 12, fontWeight: '800', marginBottom: 8 }, outputOptions: { flexDirection: 'row', gap: 8, marginBottom: 10 },
  outputOption: { flex: 1, minHeight: 40, alignItems: 'center', justifyContent: 'center', borderRadius: 11, borderWidth: 1, borderColor: '#2B4055', backgroundColor: '#0B1522' }, outputOptionActive: { borderColor: '#45D7B4', backgroundColor: '#174338' }, outputOptionText: { color: '#B8C8D7', fontSize: 12, fontWeight: '700' }, outputOptionTextActive: { color: '#69E6C5' },
  xtreamHelp: { color: '#91A8BE', fontSize: 11, lineHeight: 16, marginTop: 2 },
  modalHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }, modalTitle: { color: '#F4F7FC', fontSize: 21, fontWeight: '900' }, modalSub: { color: '#91A8BE', fontSize: 13, marginTop: 4 }, close: { color: '#D8E4EF', fontSize: 30, paddingHorizontal: 8 },
  input: { height: 50, borderWidth: 1, borderColor: '#2B4055', backgroundColor: '#0B1522', color: '#F4F7FC', borderRadius: 13, paddingHorizontal: 14, fontSize: 14, marginBottom: 11 }, urlInput: { marginTop: 1 },
  playerScreen: { flex: 1, backgroundColor: '#050910', paddingHorizontal: 14, paddingTop: 10 }, mobilePlayerActions: { minHeight: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }, backButton: { paddingVertical: 9, paddingHorizontal: 13, borderRadius: 12, backgroundColor: '#112332', borderWidth: 1, borderColor: '#31546B' },
  playerActionRow: { flexDirection: 'row', alignItems: 'center', gap: 8 }, playerAction: { width: 38, height: 36, alignItems: 'center', justifyContent: 'center', borderRadius: 10, backgroundColor: '#112332', borderWidth: 1, borderColor: '#31546B' }, playerActionText: { color: '#D9F6EE', fontSize: 17, fontWeight: '900' },
  trackMenu: { position: 'absolute', zIndex: 10, left: 9, top: 9, gap: 7 }, trackButton: { width: 38, height: 36, alignItems: 'center', justifyContent: 'center', borderRadius: 10, backgroundColor: '#071522E8', borderWidth: 1, borderColor: '#31546B' }, trackModal: { maxHeight: '75%', backgroundColor: '#111D2C', borderRadius: 20, padding: 20, borderWidth: 1, borderColor: '#294157', minWidth: 280, maxWidth: 520, alignSelf: 'center' }, trackChoice: { minHeight: 46, justifyContent: 'center', paddingHorizontal: 14, marginBottom: 7, borderRadius: 11, borderWidth: 1, borderColor: '#2B4055', backgroundColor: '#0B1522' }, trackChoiceActive: { borderColor: '#45D7B4', backgroundColor: '#174338' }, trackChoiceText: { color: '#F4F7FC', fontSize: 14, fontWeight: '700' }, trackEmpty: { color: '#A9BCD1', paddingVertical: 10, fontSize: 13 },
  restartButton: { alignSelf: 'flex-start', minHeight: 40, justifyContent: 'center', marginHorizontal: 18, marginTop: 14, paddingHorizontal: 14, borderRadius: 11, backgroundColor: '#142437', borderWidth: 1, borderColor: '#2B4055' }, restartText: { color: '#E8EFF7', fontSize: 13, fontWeight: '800' },
  videoFrame: { width: '100%', aspectRatio: 16 / 9, backgroundColor: '#000', justifyContent: 'center' }, video: { width: '100%', height: '100%' }, playerTitle: { color: '#F4F7FC', fontSize: 20, fontWeight: '800', marginTop: 18, marginHorizontal: 18 }, playerMeta: { color: '#9FB4CA', fontSize: 13, marginTop: 6, marginHorizontal: 18 },
});
