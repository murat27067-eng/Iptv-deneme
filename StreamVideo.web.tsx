import React, { useEffect, useRef, useState } from 'react';
import { StyleProp, StyleSheet, Text, TouchableOpacity, View, ViewStyle } from 'react-native';
import Hls from 'hls.js';
import mpegts from 'mpegts.js';

type TrackOption = { id: string; label: string };
type SeriesNavigation = { seasons: { season: number; episodes: { id: string; name: string }[] }[]; selectedSeason: number; currentItemId: string; onSelectSeason: (season: number) => void; onSelectEpisode: (id: string) => void };
type Props = { uri: string; title?: string; style?: StyleProp<ViewStyle>; initialPosition?: number; reloadKey?: number; fullscreenRequest?: number; isLive?: boolean; showTrackControls?: boolean; compact?: boolean; seriesNavigation?: SeriesNavigation; audioTrackId?: string | null; subtitleTrackId?: string | null; onSelectAudioTrack?: (id: string | null) => void; onSelectSubtitleTrack?: (id: string | null) => void; onTracksChange?: (audio: TrackOption[], subtitles: TrackOption[]) => void; onProgress: (position: number, duration: number) => void; onPrevious?: () => void; onNext?: () => void; onRetry?: () => void; onClose?: () => void };

function formatTime(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = Math.floor(seconds % 60).toString().padStart(2, '0');
  return hours ? `${hours}:${minutes.toString().padStart(2, '0')}:${rest}` : `${minutes}:${rest}`;
}

function describeMediaError(video: HTMLVideoElement) {
  switch (video.error?.code) {
    case MediaError.MEDIA_ERR_ABORTED:
      return 'Yayın başlatma isteği iptal edildi. Yeniden bağlanmayı dene.';
    case MediaError.MEDIA_ERR_NETWORK:
      return 'Yayın sunucusuna ulaşılamadı. İnternet bağlantısını veya yayın adresini kontrol et.';
    case MediaError.MEDIA_ERR_DECODE:
      return 'Yayın verisi geldi ancak tarayıcı çözemedi. Bu içerik MP4 ya da M3U8 biçiminde olmayabilir.';
    case MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED:
      return 'Tarayıcı bu yayın biçimini desteklemiyor veya sunucu erişimi engelliyor. MP4/M3U8 bağlantısını dene.';
    default:
      return 'Yayın başlatılamadı. Bağlantıyı ve yayın biçimini kontrol et.';
  }
}

export default function StreamVideo({ uri, title = '', style, initialPosition = 0, reloadKey = 0, fullscreenRequest = 0, isLive = false, compact = false, showTrackControls = false, seriesNavigation, audioTrackId = null, subtitleTrackId = null, onSelectAudioTrack, onSelectSubtitleTrack, onTracksChange, onProgress, onPrevious, onNext, onRetry, onClose }: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const frameRef = useRef<HTMLDivElement | null>(null);
  const hlsRef = useRef<Hls | null>(null);
  const progressCallback = useRef(onProgress);
  const tracksCallback = useRef(onTracksChange);
  progressCallback.current = onProgress;
  tracksCallback.current = onTracksChange;
  const [error, setError] = useState('');
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [playbackNeedsGesture, setPlaybackNeedsGesture] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [hoveredAction, setHoveredAction] = useState<string | null>(null);
  const [audioTracks, setAudioTracks] = useState<TrackOption[]>([]);
  const [subtitleTracks, setSubtitleTracks] = useState<TrackOption[]>([]);
  const [subtitleNotice, setSubtitleNotice] = useState('');
  const [trackPicker, setTrackPicker] = useState<'audio' | 'subtitles' | null>(null);
  const [episodePickerPage, setEpisodePickerPage] = useState<'seasons' | 'episodes' | null>(null);
  const [episodePickerSeason, setEpisodePickerSeason] = useState(0);
  const playingRef = useRef(false);
  playingRef.current = playing;
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handledFullscreenRequest = useRef(fullscreenRequest);


  const publishTracks = () => {
    const hls = hlsRef.current;
    const audio = hls?.audioTracks.map((track, index) => ({ id: String(index), label: track.name || track.lang || `Ses ${index + 1}` })) || [];
    const subtitles = hls?.subtitleTracks.map((track, index) => {
      const language = track.lang ? track.lang.toLocaleUpperCase() : '';
      const name = track.name?.trim();
      const label = name && language && !name.toLocaleLowerCase().includes(language.toLocaleLowerCase()) ? `${name} · ${language}` : name || language || `Altyazı ${index + 1}`;
      return { id: String(index), label };
    }) || [];
    const nativeTextTracks = videoRef.current?.textTracks;
    const nativeAudioTracks = (videoRef.current as (HTMLVideoElement & { audioTracks?: { length: number; [index: number]: { label?: string; language?: string; enabled?: boolean } }; webkitAudioTracks?: { length: number; [index: number]: { label?: string; language?: string; enabled?: boolean } } }) | null)?.audioTracks;
    const audioTrackList = nativeAudioTracks || (videoRef.current as any)?.webkitAudioTracks;
    if (!audio.length && audioTrackList?.length) for (let index = 0; index < audioTrackList.length; index += 1) {
      const track = audioTrackList[index];
      audio.push({ id: String(index), label: track.label || track.language || `Ses ${index + 1}` });
    }
    if (!subtitles.length && nativeTextTracks?.length) for (let index = 0; index < nativeTextTracks.length; index += 1) {
      const track = nativeTextTracks[index];
      if (track.kind === 'subtitles' || track.kind === 'captions') subtitles.push({ id: String(index), label: track.label || track.language || `Altyazı ${index + 1}` });
    }
    setAudioTracks(audio); setSubtitleTracks(subtitles); tracksCallback.current?.(audio, subtitles);
  };

  useEffect(() => {
    const hls = hlsRef.current;
    if (hls && audioTrackId !== null) hls.audioTrack = Number(audioTrackId);
    const browserAudioTracks = ((videoRef.current as any)?.audioTracks || (videoRef.current as any)?.webkitAudioTracks) as { length: number; [index: number]: { enabled: boolean } } | undefined;
    if (browserAudioTracks && audioTrackId !== null) for (let index = 0; index < browserAudioTracks.length; index += 1) browserAudioTracks[index].enabled = String(index) === audioTrackId;
  }, [audioTrackId]);
  useEffect(() => {
    const hls = hlsRef.current;
    if (hls) { hls.subtitleTrack = subtitleTrackId === null ? -1 : Number(subtitleTrackId); hls.subtitleDisplay = subtitleTrackId !== null; }
    const tracks = videoRef.current?.textTracks;
    if (tracks) for (let index = 0; index < tracks.length; index += 1) tracks[index].mode = String(index) === subtitleTrackId ? 'showing' : 'disabled';
  }, [subtitleTrackId]);

  const revealControls = () => {
    setControlsVisible(true);
    if (hideTimer.current) clearTimeout(hideTimer.current);
    if (playingRef.current) hideTimer.current = setTimeout(() => setControlsVisible(false), 3000);
  };

  const togglePlay = () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) void video.play().then(() => { setPlaybackNeedsGesture(false); setError(''); }).catch((reason: unknown) => {
      if (reason instanceof DOMException && reason.name === 'NotAllowedError') {
        setPlaybackNeedsGesture(true);
        setError('Tarayıcı oynatmayı engelledi. Oynat düğmesine yeniden dokun.');
      } else if (!(reason instanceof DOMException && reason.name === 'AbortError')) {
        setError(describeMediaError(video));
      }
    });
    else video.pause();
    revealControls();
  };
  const handleVideoClick = () => {
    if (clickTimer.current) clearTimeout(clickTimer.current);
    clickTimer.current = setTimeout(() => { clickTimer.current = null; togglePlay(); }, 240);
  };
  const seekBy = (seconds: number) => {
    const video = videoRef.current;
    if (!video || isLive || !Number.isFinite(video.duration) || video.duration <= 0) return;
    // For VOD, seekable often reports only the currently buffered segment. Clamping
    // to that range makes the 10-second buttons appear to do nothing.
    const target = Math.max(0, Math.min(video.duration, video.currentTime + seconds));
    try {
      video.currentTime = target;
      // HLS can otherwise keep fetching around the old playhead on some sources.
      hlsRef.current?.startLoad(target);
      setCurrentTime(target);
      progressCallback.current(target, video.duration);
      setError('');
    } catch {
      setError('Bu yayın konum değiştirmeyi desteklemiyor.');
    }
    revealControls();
  };
  const stopPlayback = () => { const video = videoRef.current; if (!video) return; video.pause(); if (!isLive) video.currentTime = 0; revealControls(); };

  const toggleFullscreen = async () => {
    const frame = frameRef.current as (HTMLDivElement & { webkitRequestFullscreen?: () => void }) | null;
    if (!frame) return;
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else if (frame.requestFullscreen) await frame.requestFullscreen();
      else frame.webkitRequestFullscreen?.();
    } catch { setError('Tam ekran bu tarayıcıda açılamadı.'); }
  };

  useEffect(() => {
    if (fullscreenRequest <= handledFullscreenRequest.current) return;
    handledFullscreenRequest.current = fullscreenRequest;
    setFullscreen(true);
    revealControls();
  }, [fullscreenRequest]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    let hls: Hls | null = null;
    let transport: ReturnType<typeof mpegts.createPlayer> | null = null;
    let cancelled = false;
    let restored = false;
    let recoveryAttempts = 0;
    let recoveryPosition = 0;
    let recoveryTimer: ReturnType<typeof setTimeout> | null = null;
    let stallTimer: ReturnType<typeof setTimeout> | null = null;
    let stableTimer: ReturnType<typeof setTimeout> | null = null;
    let recoveryResumeHandler: (() => void) | null = null;
    let triedTransportFallback = false;
    setError('');
    setSubtitleNotice('');
    setPlaybackNeedsGesture(false);
    setAudioTracks([]); setSubtitleTracks([]); tracksCallback.current?.([], []);
    video.pause();
    video.removeAttribute('src');
    video.load();

    const restoreAndPlay = () => {
      if (!restored && initialPosition > 5 && video.readyState > 0) {
        try { video.currentTime = initialPosition; } catch { /* The stream may not be seekable. */ }
        restored = true;
      }
      video.play().catch(() => {
        if (!cancelled) { setPlaybackNeedsGesture(true); setError('Tarayıcı otomatik başlatmayı engelledi. Oynat düğmesine dokun.'); }
      });
    };
    const reportProgress = () => progressCallback.current(video.currentTime || 0, Number.isFinite(video.duration) ? video.duration : 0);
    const clearPlaybackNotice = () => { setError(''); setPlaybackNeedsGesture(false); };
    const updatePlayback = () => { setCurrentTime(video.currentTime || 0); setDuration(Number.isFinite(video.duration) ? video.duration : 0); };
    const startTransportFallback = () => {
      if (cancelled || triedTransportFallback || !mpegts.isSupported()) return false;
      triedTransportFallback = true;
      video.pause();
      video.removeAttribute('src');
      video.load();
      transport = mpegts.createPlayer({ type: 'mpegts', url: uri, isLive: false }, { enableWorker: true, lazyLoad: false, enableStashBuffer: true, stashInitialSize: 2 * 1024 * 1024 });
      transport.on(mpegts.Events.ERROR, () => {
        if (!cancelled) setError('Bu film/dizi akışı tarayıcıda çözümlenemedi. Sağlayıcının MP4 veya M3U8 bağlantısını dene.');
      });
      transport.attachMediaElement(video);
      transport.load();
      void transport.play().then(() => { if (!cancelled) { setError(''); setPlaybackNeedsGesture(false); } }).catch(() => {
        if (!cancelled) { setPlaybackNeedsGesture(true); setError('Oynatmayı başlatmak için Oynat düğmesine dokun.'); }
      });
      return true;
    };
    const recoverPlayback = (message = 'Yayın takıldı') => {
      if (cancelled || recoveryTimer || recoveryAttempts >= 6) return;
      recoveryAttempts += 1;
      recoveryPosition = video.currentTime || 0;
      setError(`${message}. Bağlantı yenileniyor (${recoveryAttempts}/6)…`);
      recoveryTimer = setTimeout(() => {
        recoveryTimer = null;
        if (cancelled) return;
        if (hls) {
          if (video.error) { try { hls.recoverMediaError(); } catch { hls.startLoad(); } }
          else hls.startLoad();
        } else if (transport) {
          try { transport.unload(); transport.load(); void Promise.resolve(transport.play()).catch(() => {}); } catch { setError('Yayın yeniden başlatılamadı. Yeniden bağlan düğmesini kullan.'); }
        } else if (video.src) {
          const resumeAfterReload = () => {
            video.removeEventListener('loadedmetadata', resumeAfterReload);
            recoveryResumeHandler = null;
            if (!isLive && recoveryPosition > 0 && Number.isFinite(video.duration)) video.currentTime = Math.min(recoveryPosition, video.duration);
            void video.play().catch(() => {});
          };
          recoveryResumeHandler = resumeAfterReload;
          video.addEventListener('loadedmetadata', resumeAfterReload);
          video.load();
        }
      }, Math.min(1200 * (2 ** (recoveryAttempts - 1)), 10_000));
    };
    const watchStall = () => {
      if (cancelled || video.paused) return;
      if (stallTimer) clearTimeout(stallTimer);
      stallTimer = setTimeout(() => { stallTimer = null; recoverPlayback(); }, 10_000);
      if (stableTimer) { clearTimeout(stableTimer); stableTimer = null; }
    };
    const markPlaying = () => {
      if (recoveryTimer) { clearTimeout(recoveryTimer); recoveryTimer = null; }
      if (stallTimer) { clearTimeout(stallTimer); stallTimer = null; }
      if (!stableTimer) stableTimer = setTimeout(() => { recoveryAttempts = 0; stableTimer = null; }, 30_000);
      setPlaying(true);
      setControlsVisible(true);
      if (hideTimer.current) clearTimeout(hideTimer.current);
      hideTimer.current = setTimeout(() => setControlsVisible(false), 3000);
    };
    const markPaused = () => { setPlaying(false); setControlsVisible(true); if (hideTimer.current) clearTimeout(hideTimer.current); if (stallTimer) { clearTimeout(stallTimer); stallTimer = null; } if (stableTimer) { clearTimeout(stableTimer); stableTimer = null; } };
    const onWaiting = () => watchStall();
    const onStalled = () => watchStall();
    const onVideoError = () => {
      if (cancelled) return;
      const hlsAddress = /\.m3u8(?:[?#]|$)|[?&](?:output|type)=m3u8(?:&|$)/i.test(uri);
      if (!hlsAddress && startTransportFallback()) return;
      const extension = path.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase();
      if (['mkv', 'avi', 'wmv', 'flv', 'mpeg', 'mpg'].includes(extension || '')) {
        setError(`.${extension} biçimi bu tarayıcıda oynatılamıyor. Sağlayıcıdan MP4 veya M3U8/HLS bağlantısı iste ya da mobil uygulamada dene.`);
      } else {
        setError(describeMediaError(video));
      }
    };
    video.addEventListener('loadedmetadata', restoreAndPlay);
    video.addEventListener('canplay', restoreAndPlay);
    video.addEventListener('timeupdate', reportProgress);
    video.addEventListener('timeupdate', updatePlayback);
    video.addEventListener('playing', clearPlaybackNotice);
    video.addEventListener('playing', markPlaying);
    video.addEventListener('pause', markPaused);
    video.addEventListener('waiting', onWaiting);
    video.addEventListener('stalled', onStalled);
    video.addEventListener('loadedmetadata', updatePlayback);
    video.addEventListener('loadedmetadata', publishTracks);
    video.addEventListener('error', onVideoError);
    const nativeTextTracks = video.textTracks;
    nativeTextTracks.addEventListener('addtrack', publishTracks);
    nativeTextTracks.addEventListener('change', publishTracks);
    const path = uri.split(/[?#]/, 1)[0].toLowerCase();
    const isHls = path.endsWith('.m3u8') || /[?&](?:output|type)=m3u8(?:&|$)/i.test(uri);
    const hasKnownBrowserFormat = /\.(mp4|m4v|webm|mov|mp3|m4a|aac|ogg|wav)$/i.test(path);
    // Xtream-style live URLs often omit the .ts suffix even when the response is MPEG-TS.
    const isTransportStream = path.endsWith('.ts') || (!hasKnownBrowserFormat && isLive);

    if (isHls) {
      if (Hls.isSupported()) {
        hls = new Hls({
          enableWorker: true,
          // Be explicit so WebVTT subtitle renditions are exposed as selectable browser tracks.
          enableWebVTT: true,
          renderTextTracksNatively: true,
          subtitleDisplay: false,
          // IPTV sources often have variable segment timing. Avoid aggressive low-latency mode
          // and keep a moderate forward buffer instead of chasing the live edge.
          lowLatencyMode: false,
          maxBufferLength: isLive ? 35 : 55,
          maxMaxBufferLength: isLive ? 90 : 120,
          backBufferLength: 30,
          maxBufferHole: 0.5,
          liveSyncDurationCount: 4,
          liveMaxLatencyDurationCount: 12,
          fragLoadingMaxRetry: 8,
          fragLoadingRetryDelay: 1000,
          fragLoadingMaxRetryTimeout: 60_000,
          manifestLoadingMaxRetry: 5,
          manifestLoadingRetryDelay: 1000,
          manifestLoadingMaxRetryTimeout: 30_000,
          levelLoadingMaxRetry: 6,
          levelLoadingRetryDelay: 1000,
          levelLoadingMaxRetryTimeout: 30_000,
        });
        hlsRef.current = hls;
        hls.on(Hls.Events.MANIFEST_PARSED, publishTracks);
        hls.on(Hls.Events.LEVEL_LOADED, publishTracks);
        hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, publishTracks);
        hls.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, publishTracks);
        hls.on(Hls.Events.SUBTITLE_TRACK_LOADED, publishTracks);
        hls.on(Hls.Events.SUBTITLE_TRACK_SWITCH, publishTracks);
        hls.on(Hls.Events.ERROR, (_event, data) => {
          if (data.details === Hls.ErrorDetails.SUBTITLE_LOAD_ERROR || data.details === Hls.ErrorDetails.SUBTITLE_TRACK_LOAD_TIMEOUT) {
            setSubtitleNotice('Altyazı parçası bulundu ancak yayın sunucusundan indirilemedi.');
          }
          if (data.fatal && !cancelled) {
            if (data.type === Hls.ErrorTypes.NETWORK_ERROR && recoveryAttempts < 6) recoverPlayback('Ağ bağlantısı kesildi');
            else if (data.type === Hls.ErrorTypes.MEDIA_ERROR && recoveryAttempts < 6) recoverPlayback('Video akışı yeniden düzenleniyor');
            else if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
              const status = data.response?.code;
              setError(status === 401 || status === 403
                ? `Yayın sunucusu erişimi reddetti (${status}). Playlist hesabını ve bağlantı süresini kontrol et.`
                : status === 404
                  ? 'Yayın sunucusunda bu içerik bulunamadı (404). Playlist bağlantısını yenile.'
                  : 'HLS yayınına ulaşılamadı. Sunucu çevrimdışı olabilir veya tarayıcı erişimi (CORS) engelleniyor olabilir.');
            } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
              setError('HLS video verisi tarayıcıda çözümlenemedi. Yayın biçimi veya kodlaması desteklenmiyor olabilir.');
            } else setError('HLS yayını başlatılamadı. Yayın adresini ve sağlayıcı erişimini kontrol et.');
          }
        });
        hls.on(Hls.Events.MANIFEST_PARSED, restoreAndPlay);
        hls.loadSource(uri);
        hls.attachMedia(video);
      } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = uri;
      video.addEventListener('error', () => !cancelled && setError('HLS akışı tarayıcıya ulaşamadı. Yayın adresini veya sunucu erişimini kontrol et.'), { once: true });
        video.load();
      } else {
        setError('Bu tarayıcı HLS yayın biçimini desteklemiyor. getIPTV mobil uygulamasında açmayı dene.');
      }
    } else if (isTransportStream) {
      if (mpegts.isSupported()) {
        triedTransportFallback = true;
        transport = mpegts.createPlayer({ type: 'mpegts', url: uri, isLive }, { enableWorker: true, lazyLoad: false, enableStashBuffer: true, stashInitialSize: 2 * 1024 * 1024, liveBufferLatencyChasing: false });
        transport.on(mpegts.Events.ERROR, () => !cancelled && recoverPlayback('TS bağlantısı kesildi'));
        transport.attachMediaElement(video);
        transport.load();
        void transport.play().catch(() => { if (!cancelled) { setPlaybackNeedsGesture(true); setError('Tarayıcı otomatik başlatmayı engelledi. Oynat düğmesine dokun.'); } });
      } else {
        setError('Bu tarayıcı MPEG-TS akışını desteklemiyor. getIPTV mobil uygulamasında açmayı dene.');
      }
    } else {
      video.src = uri;
      video.load();
    }

    return () => {
      cancelled = true;
      video.removeEventListener('loadedmetadata', restoreAndPlay);
      video.removeEventListener('canplay', restoreAndPlay);
      video.removeEventListener('timeupdate', reportProgress);
      video.removeEventListener('timeupdate', updatePlayback);
      video.removeEventListener('playing', clearPlaybackNotice);
      video.removeEventListener('playing', markPlaying);
      video.removeEventListener('pause', markPaused);
      video.removeEventListener('waiting', onWaiting);
      video.removeEventListener('stalled', onStalled);
      video.removeEventListener('loadedmetadata', updatePlayback);
      video.removeEventListener('loadedmetadata', publishTracks);
      video.removeEventListener('error', onVideoError);
      nativeTextTracks.removeEventListener('addtrack', publishTracks);
      nativeTextTracks.removeEventListener('change', publishTracks);
      if (hlsRef.current === hls) hlsRef.current = null;
      if (recoveryTimer) clearTimeout(recoveryTimer);
      if (stallTimer) clearTimeout(stallTimer);
      if (stableTimer) clearTimeout(stableTimer);
      if (recoveryResumeHandler) video.removeEventListener('loadedmetadata', recoveryResumeHandler);
      hls?.destroy();
      if (transport) { transport.pause(); transport.unload(); transport.detachMediaElement(); transport.destroy(); }
      video.pause();
      video.removeAttribute('src');
      video.load();
    };
  }, [uri, initialPosition, reloadKey]);

  useEffect(() => () => { if (hideTimer.current) clearTimeout(hideTimer.current); if (clickTimer.current) clearTimeout(clickTimer.current); }, []);
  useEffect(() => {
    const syncFullscreen = () => { setFullscreen(document.fullscreenElement === frameRef.current || document.fullscreenElement === document.documentElement); revealControls(); };
    document.addEventListener('fullscreenchange', syncFullscreen);
    window.addEventListener('resize', revealControls);
    return () => { document.removeEventListener('fullscreenchange', syncFullscreen); window.removeEventListener('resize', revealControls); };
  }, []);

  const sideAction = (id: string, label: string, icon: string, onPress: () => void) => <TouchableOpacity key={id} accessibilityRole="button" accessibilityLabel={label} onHoverIn={() => setHoveredAction(id)} onHoverOut={() => setHoveredAction((current) => current === id ? null : current)} onFocus={() => setHoveredAction(id)} onBlur={() => setHoveredAction((current) => current === id ? null : current)} style={[styles.sideAction, fullscreen && styles.sideActionFullscreen, hoveredAction === id && styles.sideActionExpanded]} onPress={onPress}><Text style={styles.controlGlyph}>{icon}</Text>{hoveredAction === id ? <Text style={styles.sideActionLabel}>{label}</Text> : null}</TouchableOpacity>;
  const selectAudio = (id: string | null) => {
    const hls = hlsRef.current;
    if (hls) hls.audioTrack = id === null ? -1 : Number(id);
    const list = ((videoRef.current as any)?.audioTracks || (videoRef.current as any)?.webkitAudioTracks) as { length: number; [index: number]: { enabled: boolean } } | undefined;
    if (list) for (let index = 0; index < list.length; index += 1) list[index].enabled = id !== null && String(index) === id;
    onSelectAudioTrack?.(id); setTrackPicker(null);
  };
  const selectSubtitle = (id: string | null) => {
    setSubtitleNotice('');
    const hls = hlsRef.current;
    if (hls) { hls.subtitleTrack = id === null ? -1 : Number(id); hls.subtitleDisplay = id !== null; }
    const list = videoRef.current?.textTracks;
    if (list) for (let index = 0; index < list.length; index += 1) list[index].mode = String(index) === id ? 'showing' : 'disabled';
    onSelectSubtitleTrack?.(id); setTrackPicker(null);
  };

  return <View ref={frameRef as any} {...({ onMouseMove: revealControls, onTouchStart: revealControls, onDoubleClick: (event: React.MouseEvent<HTMLDivElement>) => { const target = event.target as HTMLElement; if (target.closest('button,[role="button"],input')) return; if (clickTimer.current) { clearTimeout(clickTimer.current); clickTimer.current = null; } void toggleFullscreen(); } } as any)} style={[styles.frame, style, fullscreen && styles.fullscreenFrame]}>
    {React.createElement('video', { ref: videoRef, controls: false, playsInline: true, preload: 'metadata', onClick: handleVideoClick, style: styles.video as any })}
    {error ? <View pointerEvents="none" style={styles.notice}><Text style={styles.noticeText}>{error}</Text></View> : null}
    {playbackNeedsGesture ? <TouchableOpacity accessibilityRole="button" accessibilityLabel="Yayını oynat" style={styles.startPlaybackButton} onPress={togglePlay}><Text style={styles.startPlaybackGlyph}>▶</Text><Text style={styles.startPlaybackText}>Oynat</Text></TouchableOpacity> : null}
    <View pointerEvents={controlsVisible ? 'auto' : 'none'} style={[styles.controlLayer, !controlsVisible && playing && styles.controlsHidden]}>
      <View style={[styles.sideActions, fullscreen && styles.sideActionsFullscreen]}>
        {onClose ? sideAction('back', 'Geri', '‹', onClose) : null}
        {showTrackControls ? sideAction('audio', 'Seslendirme', '♫', () => setTrackPicker((value) => value === 'audio' ? null : 'audio')) : null}
        {showTrackControls ? sideAction('subtitles', 'Altyazı', 'CC', () => setTrackPicker((value) => value === 'subtitles' ? null : 'subtitles')) : null}
        {seriesNavigation?.seasons.length ? sideAction('episodes', 'Sezon / bölüm', '▤', () => { setEpisodePickerSeason(seriesNavigation.selectedSeason); setEpisodePickerPage((value) => value ? null : 'seasons'); }) : null}
        {sideAction('fullscreen', fullscreen ? 'Tam ekrandan çık' : 'Tam ekran', '⛶', () => { void toggleFullscreen(); })}
      </View>
      {seriesNavigation && episodePickerPage ? <View style={[styles.trackPicker, styles.episodePicker, compact && !fullscreen && styles.trackPickerCompact]}>
        <View style={styles.trackPickerHeader}><View style={styles.episodePickerHeading}>{episodePickerPage === 'episodes' ? <TouchableOpacity accessibilityLabel="Sezonlara dön" onPress={() => setEpisodePickerPage('seasons')}><Text style={styles.trackPickerClose}>‹ </Text></TouchableOpacity> : null}<Text style={styles.trackPickerTitle}>{episodePickerPage === 'seasons' ? 'Sezon seç' : `Sezon ${episodePickerSeason} · Bölüm seç`}</Text></View><TouchableOpacity accessibilityLabel="Kapat" onPress={() => setEpisodePickerPage(null)}><Text style={styles.trackPickerClose}>×</Text></TouchableOpacity></View>
        <View style={styles.trackPickerChoices}>{episodePickerPage === 'seasons' ? seriesNavigation.seasons.map((season) => <TouchableOpacity key={season.season} style={[styles.trackChoice, episodePickerSeason === season.season && styles.trackChoiceActive]} onPress={() => { setEpisodePickerSeason(season.season); seriesNavigation.onSelectSeason(season.season); setEpisodePickerPage('episodes'); }}><Text style={styles.trackChoiceText}>Sezon {season.season} · {season.episodes.length} bölüm</Text></TouchableOpacity>) : (seriesNavigation.seasons.find((season) => season.season === episodePickerSeason)?.episodes || []).map((episode) => <TouchableOpacity key={episode.id} style={[styles.trackChoice, episode.id === seriesNavigation.currentItemId && styles.trackChoiceActive]} onPress={() => { seriesNavigation.onSelectEpisode(episode.id); setEpisodePickerPage(null); }}><Text style={styles.trackChoiceText} numberOfLines={2}>{episode.name}</Text></TouchableOpacity>)}</View>
      </View> : null}
      {showTrackControls && trackPicker ? <View style={[styles.trackPicker, compact && !fullscreen && styles.trackPickerCompact]}>
        <View style={styles.trackPickerHeader}><Text style={styles.trackPickerTitle}>{trackPicker === 'audio' ? 'Seslendirme' : 'Altyazı'}</Text><TouchableOpacity accessibilityLabel="Kapat" onPress={() => setTrackPicker(null)}><Text style={styles.trackPickerClose}>×</Text></TouchableOpacity></View>
        <View style={styles.trackPickerChoices}>
          {trackPicker === 'audio' ? <>
            <TouchableOpacity style={[styles.trackChoice, audioTrackId === null && styles.trackChoiceActive]} onPress={() => selectAudio(null)}><Text style={styles.trackChoiceText}>Varsayılan ses</Text></TouchableOpacity>
            {audioTracks.map((track) => <TouchableOpacity key={track.id} style={[styles.trackChoice, audioTrackId === track.id && styles.trackChoiceActive]} onPress={() => selectAudio(track.id)}><Text style={styles.trackChoiceText}>{track.label}</Text></TouchableOpacity>)}
            {!audioTracks.length ? <Text style={styles.trackEmpty}>Bu yayın seslendirme seçeneği bildirmiyor.</Text> : null}
          </> : <>
            <TouchableOpacity style={[styles.trackChoice, subtitleTrackId === null && styles.trackChoiceActive]} onPress={() => selectSubtitle(null)}><Text style={styles.trackChoiceText}>Altyazı kapalı</Text></TouchableOpacity>
            {subtitleTracks.map((track) => <TouchableOpacity key={track.id} style={[styles.trackChoice, subtitleTrackId === track.id && styles.trackChoiceActive]} onPress={() => selectSubtitle(track.id)}><Text style={styles.trackChoiceText}>{track.label}</Text></TouchableOpacity>)}
            {!subtitleTracks.length ? <Text style={styles.trackEmpty}>Bu yayın altyazı seçeneği bildirmiyor.</Text> : null}
            {subtitleNotice ? <Text style={styles.trackEmpty}>{subtitleNotice}</Text> : null}
          </>}
        </View>
      </View> : null}
      <View style={styles.controlBottom}>
        <View style={styles.controlButtons}>
          {onPrevious ? <TouchableOpacity accessibilityRole="button" accessibilityLabel={isLive ? 'Önceki kanal' : 'Önceki bölüm'} style={styles.controlButton} onPress={onPrevious}><Text style={styles.controlGlyph}>⏮</Text></TouchableOpacity> : null}
          {!isLive ? <TouchableOpacity accessibilityRole="button" accessibilityLabel="10 saniye geri sar" style={styles.controlButton} onPress={() => seekBy(-10)}><Text style={styles.seekGlyph}>↶10</Text></TouchableOpacity> : null}
          <TouchableOpacity accessibilityRole="button" accessibilityLabel={playing ? 'Duraklat' : 'Oynat'} style={styles.controlButton} onPress={togglePlay}><Text style={styles.controlGlyph}>{playing ? 'Ⅱ' : '▶'}</Text></TouchableOpacity>
          {!isLive ? <TouchableOpacity accessibilityRole="button" accessibilityLabel="Durdur ve başa al" style={styles.controlButton} onPress={stopPlayback}><Text style={styles.controlGlyph}>■</Text></TouchableOpacity> : null}
          {!isLive ? <TouchableOpacity accessibilityRole="button" accessibilityLabel="10 saniye ileri sar" style={styles.controlButton} onPress={() => seekBy(10)}><Text style={styles.seekGlyph}>↷10</Text></TouchableOpacity> : null}
          {onNext ? <TouchableOpacity accessibilityRole="button" accessibilityLabel={isLive ? 'Sonraki kanal' : 'Sonraki bölüm'} style={styles.controlButton} onPress={onNext}><Text style={styles.controlGlyph}>⏭</Text></TouchableOpacity> : null}
          {onRetry ? <TouchableOpacity accessibilityRole="button" accessibilityLabel="Yeniden bağlan" style={styles.controlButton} onPress={onRetry}><Text style={styles.controlGlyph}>↻</Text></TouchableOpacity> : null}
          <View style={styles.controlSpacer} />
          <Text style={styles.controlTime}>{formatTime(currentTime)}{duration > 0 ? ` · −${formatTime(Math.max(0, duration - currentTime))}` : ''}</Text>
        </View>
        {duration > 0 && !isLive ? <View style={styles.seekBarBlock}>{React.createElement('input', { type: 'range', min: 0, max: duration, step: 1, value: Math.min(currentTime, duration), 'aria-label': 'Oynatma konumu', onInput: (event: React.FormEvent<HTMLInputElement>) => { const position = Number(event.currentTarget.value); setCurrentTime(position); if (videoRef.current) videoRef.current.currentTime = position; }, onChange: (event: React.ChangeEvent<HTMLInputElement>) => { const position = Number(event.target.value); setCurrentTime(position); if (videoRef.current) videoRef.current.currentTime = position; }, style: { ...styles.seekBar, accentColor: '#45D7B4' } as any })}</View> : null}
      </View>
    </View>
  </View>;
}

const styles = StyleSheet.create({
  frame: { flex: 1, minWidth: 0, minHeight: 0, backgroundColor: '#000', position: 'relative', overflow: 'hidden' },
  fullscreenFrame: { position: 'fixed', inset: 0, width: '100%', height: '100%', aspectRatio: undefined, zIndex: 99999 },
  video: { position: 'absolute', inset: 0, width: '100%', height: '100%', backgroundColor: '#000', objectFit: 'contain' },
  notice: { position: 'absolute', left: 12, right: 12, top: 12, padding: 10, borderRadius: 9, backgroundColor: '#09111edc' },
  noticeText: { color: '#F4F7FC', fontSize: 12, textAlign: 'center' },
  startPlaybackButton: { position: 'absolute', zIndex: 5, alignSelf: 'center', top: '42%', minWidth: 132, minHeight: 54, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, paddingHorizontal: 18, borderRadius: 15, backgroundColor: '#102D39F2', borderWidth: 1, borderColor: '#45D7B4' },
  startPlaybackGlyph: { color: '#69E6C5', fontSize: 20, fontWeight: '900' }, startPlaybackText: { color: '#F4F7FC', fontSize: 15, fontWeight: '900' },
  controlLayer: { ...StyleSheet.absoluteFillObject, justifyContent: 'space-between', backgroundColor: '#00000020' },
  controlsHidden: { opacity: 0 },
  sideActions: { position: 'absolute', left: 12, top: '8%', zIndex: 3, gap: 6, overflow: 'visible' },
  sideActionsFullscreen: { left: 22, top: '20%', gap: 11 },
  sideAction: { width: 44, height: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-start', gap: 10, paddingHorizontal: 10, overflow: 'visible', borderRadius: 12, backgroundColor: '#102332f2', borderWidth: 1, borderColor: '#4c718288' },
  sideActionFullscreen: { width: 54, height: 54, paddingHorizontal: 13, borderRadius: 14 },
  sideActionExpanded: { width: 174, backgroundColor: '#102332f7', borderColor: '#45D7B4', zIndex: 5 },
  sideActionLabel: { color: '#E9FFF8', fontSize: 14, fontWeight: '800', flexShrink: 0 },
  trackPicker: { position: 'absolute', zIndex: 8, left: 78, top: '27%', width: 280, maxHeight: '58%', padding: 12, borderRadius: 14, borderWidth: 1, borderColor: '#45D7B4', backgroundColor: '#071522F5' }, episodePicker: { left: 66, top: '18%', width: 300, maxHeight: '68%' }, trackPickerCompact: { left: 8, top: 8, maxHeight: '76%' }, episodePickerHeading: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  trackPickerHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingBottom: 9 },
  trackPickerTitle: { color: '#F4F7FC', fontSize: 15, fontWeight: '900' },
  trackPickerClose: { color: '#69E6C5', fontSize: 24, fontWeight: '700', paddingHorizontal: 6 },
  trackPickerChoices: { maxHeight: '100%', overflow: 'auto' as any },
  trackChoice: { minHeight: 42, justifyContent: 'center', paddingHorizontal: 11, marginTop: 5, borderRadius: 9, borderWidth: 1, borderColor: '#294157', backgroundColor: '#101D2B' },
  trackChoiceActive: { borderColor: '#45D7B4', backgroundColor: '#174338' },
  trackChoiceText: { color: '#F4F7FC', fontSize: 13, fontWeight: '700' },
  controlBottom: { position: 'absolute', left: 0, right: 0, bottom: 0, zIndex: 4, paddingHorizontal: 9, paddingTop: 4, paddingBottom: 5, backgroundColor: '#03070a66' },
  nowPlayingTitle: { color: '#F4F7FC', fontSize: 14, fontWeight: '800', paddingHorizontal: 5, paddingBottom: 4 },
  controlButtons: { minHeight: 30, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 4 }, controlSpacer: { flex: 1 },
  controlButton: { minWidth: 32, height: 30, paddingHorizontal: 6, alignItems: 'center', justifyContent: 'center', borderRadius: 8, backgroundColor: '#102332c9', borderWidth: 1, borderColor: '#4c718266' },
  controlGlyph: { color: '#E9FFF8', fontSize: 16, fontWeight: '900' },
  controlTime: { color: '#F4F7FC', fontSize: 13, fontWeight: '700', marginLeft: 3, textAlign: 'right' }, seekGlyph: { color: '#E9FFF8', fontSize: 14, fontWeight: '900' },
  seekBarBlock: { width: '100%', marginTop: 1 }, seekBar: { width: '100%', height: 14, marginTop: 0 },
});
