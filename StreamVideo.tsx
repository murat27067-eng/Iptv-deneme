import React, { useEffect, useRef, useState } from 'react';
import { ScrollView, StyleProp, Text, TouchableOpacity, View, ViewStyle } from 'react-native';
import { VideoView, useVideoPlayer } from 'expo-video';

type TrackOption = { id: string; label: string };
type SeriesNavigation = { seasons: { season: number; episodes: { id: string; name: string }[] }[]; selectedSeason: number; currentItemId: string; onSelectSeason: (season: number) => void; onSelectEpisode: (id: string) => void };
type Props = { uri: string; title?: string; style?: StyleProp<ViewStyle>; initialPosition?: number; reloadKey?: number; fullscreenRequest?: number; isLive?: boolean; showTrackControls?: boolean; compact?: boolean; seriesNavigation?: SeriesNavigation; audioTrackId?: string | null; subtitleTrackId?: string | null; onSelectAudioTrack?: (id: string | null) => void; onSelectSubtitleTrack?: (id: string | null) => void; onTracksChange?: (audio: TrackOption[], subtitles: TrackOption[]) => void; onProgress: (position: number, duration: number) => void; onPrevious?: () => void; onNext?: () => void; onRetry?: () => void; onClose?: () => void };

function formatTime(seconds: number) { if (!Number.isFinite(seconds) || seconds < 0) return '0:00'; const h = Math.floor(seconds / 3600); const m = Math.floor((seconds % 3600) / 60); const s = Math.floor(seconds % 60).toString().padStart(2, '0'); return h ? `${h}:${m.toString().padStart(2, '0')}:${s}` : `${m}:${s}`; }

export default function StreamVideo({ uri, style, initialPosition = 0, reloadKey = 0, isLive = false, showTrackControls = false, compact = false, seriesNavigation, audioTrackId = null, subtitleTrackId = null, onSelectAudioTrack, onSelectSubtitleTrack, onTracksChange, onProgress, onPrevious, onNext, onRetry, onClose }: Props) {
  const videoViewRef = useRef<VideoView | null>(null);
  const progressCallback = useRef(onProgress);
  const tracksCallback = useRef(onTracksChange);
  progressCallback.current = onProgress;
  tracksCallback.current = onTracksChange;
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [seekWidth, setSeekWidth] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [recoveryMessage, setRecoveryMessage] = useState('');
  const [hoveredAction, setHoveredAction] = useState<string | null>(null);
  const [tracks, setTracks] = useState<{ audio: TrackOption[]; subtitles: TrackOption[] }>({ audio: [], subtitles: [] });
  const [trackPicker, setTrackPicker] = useState<'audio' | 'subtitles' | null>(null);
  const [episodePickerPage, setEpisodePickerPage] = useState<'seasons' | 'episodes' | null>(null);
  const [episodePickerSeason, setEpisodePickerSeason] = useState(0);
  const recoveryAttempts = useRef(0);
  const recoveryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isHls = /\.m3u8(?:$|[?#])/i.test(uri) || /[?&](?:output|type)=m3u8(?:&|$)/i.test(uri);
  const isTransportStream = /\.ts(?:$|[?#])/i.test(uri);
  const player = useVideoPlayer({ uri, contentType: isHls ? 'hls' : isLive || isTransportStream ? 'auto' : 'progressive' }, (instance) => {
    instance.timeUpdateEventInterval = 1;
    instance.bufferOptions = { preferredForwardBufferDuration: isLive ? 30 : 55, minBufferForPlayback: 10, waitsToMinimizeStalling: true, prioritizeTimeOverSizeThreshold: true };
    instance.play();
  });
  useEffect(() => {
    player.bufferOptions = { preferredForwardBufferDuration: isLive ? 30 : 55, minBufferForPlayback: 10, waitsToMinimizeStalling: true, prioritizeTimeOverSizeThreshold: true };
  }, [player, isLive, uri]);
  useEffect(() => { recoveryAttempts.current = 0; }, [uri, reloadKey]);
  useEffect(() => {
    if (reloadKey < 1) return;
    void player.replaceAsync({ uri, contentType: isHls ? 'hls' : isLive || isTransportStream ? 'auto' : 'progressive' }).then(() => {
      if (initialPosition > 5) player.currentTime = initialPosition;
      player.play();
    }).catch(() => {});
  }, [player, reloadKey, uri, initialPosition, isHls, isLive, isTransportStream]);
  const publishTracks = () => {
    const audio = player.availableAudioTracks.map((track, index) => ({ id: track.id || String(index), label: track.label || track.name || track.language || `Ses ${index + 1}` }));
    const subtitles = player.availableSubtitleTracks.map((track, index) => ({ id: track.id || String(index), label: track.label || track.name || track.language || `Altyazı ${index + 1}` }));
    setTracks({ audio, subtitles });
    tracksCallback.current?.(audio, subtitles);
  };
  useEffect(() => {
    const progress = player.addListener('timeUpdate', (event) => { setCurrentTime(event.currentTime); setDuration(player.duration || 0); progressCallback.current(event.currentTime, player.duration); });
    let stablePlaybackTimer: ReturnType<typeof setTimeout> | null = null;
    const playingChange = player.addListener('playingChange', (event) => {
      setPlaying(event.isPlaying);
      if (event.isPlaying) {
        setRecoveryMessage('');
        if (!stablePlaybackTimer) stablePlaybackTimer = setTimeout(() => { recoveryAttempts.current = 0; stablePlaybackTimer = null; }, 30_000);
      } else if (stablePlaybackTimer) { clearTimeout(stablePlaybackTimer); stablePlaybackTimer = null; }
    });
    const loaded = player.addListener('sourceLoad', publishTracks);
    const audioChanged = player.addListener('availableAudioTracksChange', publishTracks);
    const subtitlesChanged = player.addListener('availableSubtitleTracksChange', publishTracks);
    let resumeApplied = false;
    const resume = () => {
      if (resumeApplied || player.status !== 'readyToPlay') return;
      resumeApplied = true;
      publishTracks();
      try { player.currentTime = initialPosition; } catch { /* Some live streams cannot seek. */ }
      if (initialPosition > 5) player.play();
    };
    const status = player.addListener('statusChange', (event) => {
      if (event.status === 'readyToPlay') resume();
      else if (event.status === 'error' && recoveryAttempts.current < 5 && !recoveryTimer.current) {
        recoveryAttempts.current += 1;
        setRecoveryMessage(`Yayın bağlantısı toparlanıyor (${recoveryAttempts.current}/5)…`);
        recoveryTimer.current = setTimeout(() => {
          recoveryTimer.current = null;
          void player.replaceAsync({ uri, contentType: isHls ? 'hls' : isLive || isTransportStream ? 'auto' : 'progressive' }).then(() => {
            if (initialPosition > 5) player.currentTime = initialPosition;
            player.play();
          }).catch(() => {});
        }, Math.min(1500 * (2 ** (recoveryAttempts.current - 1)), 12_000));
      } else if (event.status === 'error') {
        setRecoveryMessage('Bağlantı kurulamadı. Yeniden bağlanmayı deneyebilirsin.');
      }
    });
    if (player.status === 'readyToPlay') resume();
    return () => { progress.remove(); playingChange.remove(); loaded.remove(); audioChanged.remove(); subtitlesChanged.remove(); status.remove(); if (stablePlaybackTimer) clearTimeout(stablePlaybackTimer); if (recoveryTimer.current) { clearTimeout(recoveryTimer.current); recoveryTimer.current = null; } };
  }, [player, initialPosition, uri, isLive, isHls, isTransportStream]);
  useEffect(() => {
    if (audioTrackId === null) return;
    player.audioTrack = player.availableAudioTracks.find((track, index) => (track.id || String(index)) === audioTrackId) ?? null;
  }, [player, audioTrackId]);
  useEffect(() => {
    if (subtitleTrackId === null) { player.subtitleTrack = null; return; }
    player.subtitleTrack = player.availableSubtitleTracks.find((track, index) => (track.id || String(index)) === subtitleTrackId) ?? null;
  }, [player, subtitleTrackId]);
  const seekBy = (seconds: number) => {
    if (isLive || !Number.isFinite(player.duration) || player.duration <= 0) return;
    const next = Math.max(0, Math.min(player.duration, player.currentTime + seconds));
    // Assigning the absolute position keeps the mobile and web players consistent
    // and prevents a stale relative seek from being applied after rapid taps.
    player.currentTime = next;
    setCurrentTime(next);
    progressCallback.current(next, player.duration);
  };
  const seekToX = (x: number) => { if (isLive || duration <= 0 || seekWidth <= 0) return; const next = Math.max(0, Math.min(duration, (x / seekWidth) * duration)); player.currentTime = next; setCurrentTime(next); };
  const togglePlayback = () => { if (player.playing) player.pause(); else player.play(); };
  const stopPlayback = () => { player.pause(); if (!isLive) player.currentTime = 0; };
  const sideAction = (id: string, label: string, icon: string, onPress?: () => void) => onPress ? <TouchableOpacity key={id} accessibilityRole="button" accessibilityLabel={label} onHoverIn={() => setHoveredAction(id)} onHoverOut={() => setHoveredAction((current) => current === id ? null : current)} onFocus={() => setHoveredAction(id)} onBlur={() => setHoveredAction((current) => current === id ? null : current)} style={{ width: hoveredAction === id ? 150 : 46, height: 46, flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-start', gap: 9, paddingHorizontal: 11, borderRadius: 12, backgroundColor: '#102332E8', borderWidth: 1, borderColor: hoveredAction === id ? '#45D7B4' : '#4c718266' }} onPress={onPress}><Text style={{ color: '#E9FFF8', fontSize: 19, fontWeight: '900' }}>{icon}</Text>{hoveredAction === id ? <Text style={{ color: '#E9FFF8', fontSize: 12, fontWeight: '800' }}>{label}</Text> : null}</TouchableOpacity> : null;
  const chooseAudio = (id: string | null) => { onSelectAudioTrack?.(id); setTrackPicker(null); };
  const chooseSubtitle = (id: string | null) => { onSelectSubtitleTrack?.(id); setTrackPicker(null); };
  const canShowTracks = showTrackControls;
  const control = (label: string, text: string, onPress: () => void) => <TouchableOpacity key={label} accessibilityRole="button" accessibilityLabel={label} onPress={onPress} style={{ minWidth: compact ? 34 : 38, height: compact ? 32 : 36, paddingHorizontal: 6, alignItems: 'center', justifyContent: 'center', borderRadius: 9, backgroundColor: '#102332F2', borderWidth: 1, borderColor: '#4c718288' }}><Text style={{ color: '#E9FFF8', fontWeight: '900', fontSize: 12 }}>{text}</Text></TouchableOpacity>;
  const trackButtons = <>{sideAction('audio', 'Seslendirme', '♫', () => setTrackPicker((value) => value === 'audio' ? null : 'audio'))}{sideAction('subtitles', 'Altyazı', 'CC', () => setTrackPicker((value) => value === 'subtitles' ? null : 'subtitles'))}</>;
  const episodePicker = seriesNavigation && episodePickerPage ? <View style={{ position: 'absolute', left: compact ? 54 : 66, top: compact ? 8 : '18%', width: 290, maxWidth: '78%', maxHeight: compact ? '76%' : '68%', padding: 12, borderRadius: 14, borderWidth: 1, borderColor: '#45D7B4', backgroundColor: '#071522F5', zIndex: 9 }}><View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}><View style={{ flexDirection: 'row', alignItems: 'center' }}>{episodePickerPage === 'episodes' ? <TouchableOpacity accessibilityLabel="Sezonlara dön" onPress={() => setEpisodePickerPage('seasons')}><Text style={{ color: '#69E6C5', fontSize: 22 }}>‹</Text></TouchableOpacity> : null}<Text style={{ color: '#F4F7FC', fontSize: 14, fontWeight: '900' }}>{episodePickerPage === 'seasons' ? 'Sezon seç' : `Sezon ${episodePickerSeason} · Bölüm seç`}</Text></View><TouchableOpacity onPress={() => setEpisodePickerPage(null)}><Text style={{ color: '#69E6C5', fontSize: 24 }}>×</Text></TouchableOpacity></View><ScrollView>{episodePickerPage === 'seasons' ? seriesNavigation.seasons.map((season) => <TouchableOpacity key={season.season} onPress={() => { setEpisodePickerSeason(season.season); seriesNavigation.onSelectSeason(season.season); setEpisodePickerPage('episodes'); }} style={trackChoice(episodePickerSeason === season.season)}><Text style={trackChoiceText}>Sezon {season.season} · {season.episodes.length} bölüm</Text></TouchableOpacity>) : (seriesNavigation.seasons.find((season) => season.season === episodePickerSeason)?.episodes || []).map((episode) => <TouchableOpacity key={episode.id} onPress={() => { seriesNavigation.onSelectEpisode(episode.id); setEpisodePickerPage(null); }} style={trackChoice(episode.id === seriesNavigation.currentItemId)}><Text style={trackChoiceText}>{episode.name}</Text></TouchableOpacity>)}</ScrollView></View> : null;
  return <View style={{ flex: 1, backgroundColor: '#000', position: 'relative' }}><VideoView ref={videoViewRef} player={player} style={style} nativeControls={false} contentFit="contain" allowsFullscreen allowsPictureInPicture />{recoveryMessage ? <View style={{ position: 'absolute', zIndex: 9, left: 64, right: 10, top: 8, minHeight: 38, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, paddingHorizontal: 11, borderRadius: 10, backgroundColor: '#101D2BEF', borderWidth: 1, borderColor: '#D99448' }}><Text style={{ flex: 1, color: '#FFE0B3', fontSize: 11, fontWeight: '700' }}>{recoveryMessage}</Text>{recoveryMessage.startsWith('Bağlantı kurulamadı') && onRetry ? <TouchableOpacity onPress={onRetry}><Text style={{ color: '#69E6C5', fontSize: 11, fontWeight: '900' }}>Yenile</Text></TouchableOpacity> : null}</View> : null}<View style={{ position: 'absolute', left: 10, top: '26%', gap: 9, zIndex: 4 }}>{sideAction('back', 'Geri', '‹', onClose)}{canShowTracks ? trackButtons : null}{seriesNavigation?.seasons.length ? sideAction('episodes', 'Sezon / bölüm', '▤', () => { setEpisodePickerSeason(seriesNavigation.selectedSeason); setEpisodePickerPage((value) => value ? null : 'seasons'); }) : null}</View>{episodePicker}{canShowTracks && trackPicker ? <View style={{ position: 'absolute', left: compact ? 8 : 64, top: compact ? 8 : '26%', width: 270, maxWidth: '82%', maxHeight: compact ? '65%' : '62%', padding: 12, borderRadius: 14, borderWidth: 1, borderColor: '#45D7B4', backgroundColor: '#071522F5', zIndex: 8 }}><View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}><Text style={{ color: '#F4F7FC', fontSize: 15, fontWeight: '900' }}>{trackPicker === 'audio' ? 'Seslendirme' : 'Altyazı'}</Text><TouchableOpacity onPress={() => setTrackPicker(null)}><Text style={{ color: '#69E6C5', fontSize: 24 }}>×</Text></TouchableOpacity></View><ScrollView>{trackPicker === 'audio' ? <>{tracks.audio.length ? tracks.audio.map((track) => <TouchableOpacity key={track.id} onPress={() => chooseAudio(track.id)} style={trackChoice(audioTrackId === track.id)}><Text style={trackChoiceText}>{track.label}</Text></TouchableOpacity>) : <Text style={{ color: '#A9BCD1', padding: 10 }}>Yayın ses seçeneği bildirmiyor.</Text>}<TouchableOpacity onPress={() => chooseAudio(null)} style={trackChoice(audioTrackId === null)}><Text style={trackChoiceText}>Varsayılan ses</Text></TouchableOpacity></> : <><TouchableOpacity onPress={() => chooseSubtitle(null)} style={trackChoice(subtitleTrackId === null)}><Text style={trackChoiceText}>Altyazı kapalı</Text></TouchableOpacity>{tracks.subtitles.length ? tracks.subtitles.map((track) => <TouchableOpacity key={track.id} onPress={() => chooseSubtitle(track.id)} style={trackChoice(subtitleTrackId === track.id)}><Text style={trackChoiceText}>{track.label}</Text></TouchableOpacity>) : <Text style={{ color: '#A9BCD1', padding: 10 }}>Yayın altyazı seçeneği bildirmiyor.</Text>}</>}</ScrollView></View> : null}<View style={{ position: 'absolute', left: 6, right: 6, bottom: compact ? 3 : 5, gap: 1, paddingHorizontal: 5, paddingTop: 3, paddingBottom: 4, borderRadius: 8, backgroundColor: '#07111D66', zIndex: 5 }}><View style={{ minHeight: compact ? 29 : 31, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 3 }}>{onPrevious ? control(isLive ? 'Önceki kanal' : 'Önceki bölüm', '⏮', onPrevious) : null}{!isLive ? control('10 saniye geri sar', '↶10', () => seekBy(-10)) : null}{control(playing ? 'Duraklat' : 'Oynat', playing ? 'Ⅱ' : '▶', togglePlayback)}{!isLive ? control('Durdur ve başa al', '■', stopPlayback) : null}{!isLive ? control('10 saniye ileri sar', '↷10', () => seekBy(10)) : null}{onNext ? control(isLive ? 'Sonraki kanal' : 'Sonraki bölüm', '⏭', onNext) : null}{onRetry ? control('Yeniden bağlan', '↻', onRetry) : null}{control('Tam ekran', '⛶', () => { void videoViewRef.current?.enterFullscreen(); })}<View style={{ flex: 1 }} /><Text style={{ color: '#F4F7FC', fontSize: 10, fontWeight: '700' }}>{formatTime(currentTime)}{duration > 0 ? ` · −${formatTime(Math.max(0, duration - currentTime))}` : ''}</Text></View>{!isLive && duration > 0 ? <View onLayout={(event) => setSeekWidth(event.nativeEvent.layout.width)} onStartShouldSetResponder={() => true} onMoveShouldSetResponder={() => true} onResponderGrant={(event) => seekToX(event.nativeEvent.locationX)} onResponderMove={(event) => seekToX(event.nativeEvent.locationX)} style={{ height: 14, justifyContent: 'center', paddingHorizontal: 2 }}><View style={{ height: 3, width: '100%', borderRadius: 3, backgroundColor: '#5B6470', overflow: 'hidden' }}><View style={{ height: '100%', width: `${duration ? Math.min(100, (currentTime / duration) * 100) : 0}%`, backgroundColor: '#45D7B4' }} /></View></View> : null}</View></View>;
}

const trackChoice = (selected: boolean) => ({ minHeight: 42, justifyContent: 'center' as const, paddingHorizontal: 11, marginTop: 5, borderRadius: 9, borderWidth: 1, borderColor: selected ? '#45D7B4' : '#294157', backgroundColor: selected ? '#174338' : '#101D2B' });
const trackChoiceText = { color: '#F4F7FC', fontSize: 13, fontWeight: '700' as const };
