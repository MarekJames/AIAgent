"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import {
  AppBar,
  Toolbar,
  Typography,
  Box,
  Container,
  Paper,
  Stack,
  Chip,
  Button,
  Select,
  MenuItem,
  Slider,
  Alert,
  Card,
  CardContent,
  CardMedia,
  IconButton,
  Tooltip,
  CircularProgress,
  Menu,
  ListItemIcon,
  ListItemText,
  Divider,
  LinearProgress,
  TextField,
  InputAdornment,
  ToggleButton,
  ToggleButtonGroup,
  Badge,
  Tabs,
  Tab,
  FormControl,
  InputLabel,
} from "@mui/material";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import MoreVertIcon from "@mui/icons-material/MoreVert";
import SubtitlesIcon from "@mui/icons-material/Subtitles";
import CenterFocusStrongIcon from "@mui/icons-material/CenterFocusStrong";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import MovieIcon from "@mui/icons-material/Movie";
import DescriptionIcon from "@mui/icons-material/Description";
import SearchIcon from "@mui/icons-material/Search";
import SpeedIcon from "@mui/icons-material/Speed";
import QueryStatsIcon from "@mui/icons-material/QueryStats";
import AccessTimeIcon from "@mui/icons-material/AccessTime";

interface Clip {
  id: string;
  startSec: number;
  endSec: number;
  durationSec: number;
  category: string;
  tags: string[];
  scoreHook: number;
  scoreRetention: number;
  scoreClarity: number;
  scoreShare: number;
  scoreOverall: number;
  rationale: string;
  videoUrl: string;
  thumbUrl: string;
  srtUrl: string;
  tiktokStatus?: string | null;
  tiktokPublishId?: string | null;
}

interface Video {
  id: string;
  title: string;
  sourceUrl: string;
  status: string;
  durationSec: number;
  clips: Clip[];
}

type TikTokState = { state: string; publishId?: string };
type SortKey = "score" | "duration" | "start";
type ScorePreset = "any" | "60" | "70" | "80" | "90";

export default function VideoDetail() {
  const params = useParams();
  const router = useRouter();
  const [video, setVideo] = useState<Video | null>(null);
  const [loading, setLoading] = useState(true);

  const [selectedCategory, setSelectedCategory] = useState<string>("all");
  const [scoreRange, setScoreRange] = useState<number[]>([0, 100]);
  const [scorePreset, setScorePreset] = useState<ScorePreset>("any");
  const [sending, setSending] = useState<Record<string, boolean>>({});
  const [deleting, setDeleting] = useState<Record<string, boolean>>({});
  const [updating, setUpdating] = useState<Record<string, boolean>>({});
  const [centering, setCentering] = useState<Record<string, boolean>>({});
  const [ttState, setTtState] = useState<Record<string, TikTokState>>({});
  const [error, setError] = useState<string | null>(null);
  const [actionMenu, setActionMenu] = useState<
    Record<string, HTMLElement | null>
  >({});
  const [query, setQuery] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("score");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [tabCategory, setTabCategory] = useState(0);
  const [wordsPerSubtitle, setWordsPerSubtitle] = useState<
    Record<string, number>
  >({});

  const clips = video?.clips ?? [];

  const categories = useMemo(() => {
    return ["all", ...Array.from(new Set(clips.map((c) => c.category)))];
  }, [clips]);

  const isProcessing = useMemo(() => {
    const a = Object.values(updating).some(Boolean);
    const b = Object.values(centering).some(Boolean);
    if (a || b) {
      return true;
    }
    return false;
  }, [updating, centering]);

  const processingCount = useMemo(() => {
    let count = 0;
    clips.forEach((c) => {
      if (updating[c.id] || centering[c.id]) {
        count += 1;
      }
    });
    return count;
  }, [clips, updating, centering]);

  useEffect(() => {
    const idParam = (params as any)?.id;
    const id = Array.isArray(idParam) ? idParam[0] : idParam;
    if (id) {
      fetchVideo(id);
    }
  }, [params]);

  useEffect(() => {
    if (!video) {
      return;
    }
    if (video.status !== "processing") {
      return;
    }
    const handleBeforeUnload = async (e: BeforeUnloadEvent) => {
      e.preventDefault();
      try {
        await fetch(`/api/videos/${video.id}/cancel`, {
          method: "POST",
          keepalive: true,
        });
      } catch {}
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
    };
  }, [video]);

  useEffect(() => {
    if (scorePreset === "any") {
      setScoreRange([0, 100]);
      return;
    }
    if (scorePreset === "60") {
      setScoreRange([60, 100]);
      return;
    }
    if (scorePreset === "70") {
      setScoreRange([70, 100]);
      return;
    }
    if (scorePreset === "80") {
      setScoreRange([80, 100]);
      return;
    }
    if (scorePreset === "90") {
      setScoreRange([90, 100]);
      return;
    }
  }, [scorePreset]);

  const filteredClips = useMemo(() => {
    const [min, max] = scoreRange;
    let list = clips.filter((clip) => {
      if (selectedCategory !== "all" && clip.category !== selectedCategory) {
        return false;
      }
      if (clip.scoreOverall < min || clip.scoreOverall > max) {
        return false;
      }
      if (query.trim().length > 0) {
        const q = query.toLowerCase();
        const inTags = clip.tags.some((t) => t.toLowerCase().includes(q));
        const inRationale = clip.rationale.toLowerCase().includes(q);
        const inCategory = clip.category.toLowerCase().includes(q);
        if (!inTags && !inRationale && !inCategory) {
          return false;
        }
      }
      return true;
    });
    list = list.sort((a, b) => {
      if (sortKey === "score") {
        if (sortDir === "asc") {
          return a.scoreOverall - b.scoreOverall;
        }
        return b.scoreOverall - a.scoreOverall;
      }
      if (sortKey === "duration") {
        if (sortDir === "asc") {
          return a.durationSec - b.durationSec;
        }
        return b.durationSec - a.durationSec;
      }
      if (sortDir === "asc") {
        return a.startSec - b.startSec;
      }
      return b.startSec - a.startSec;
    });
    return list;
  }, [clips, selectedCategory, scoreRange, query, sortKey, sortDir]);

  function hexToRgba(hex: string, alpha: number) {
    let c = hex.replace("#", "");
    if (c.length === 3) {
      c = c
        .split("")
        .map((x) => x + x)
        .join("");
    }
    const r = parseInt(c.substring(0, 2), 16);
    const g = parseInt(c.substring(2, 4), 16);
    const b = parseInt(c.substring(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  function scoreHex(score: number) {
    if (score < 30) {
      return "#ef4444";
    }
    if (score < 45) {
      return "#f97316";
    }
    if (score < 60) {
      return "#f59e0b";
    }
    return "#22c55e";
  }

  function scoreChipSx(score: number) {
    const c = scoreHex(score);
    return {
      fontWeight: 700,
      color: hexToRgba(c, 1),
      bgcolor: hexToRgba(c, 0.12),
      borderColor: c,
      borderWidth: 1,
      borderStyle: "solid",
    };
  }

  async function fetchVideo(id: string) {
    setError(null);
    try {
      const response = await fetch(`/api/videos/${id}`);
      const data = await response.json();
      if (response.ok) {
        setVideo(data);
        const initial: Record<string, TikTokState> = {};
        data.clips?.forEach((clip: Clip) => {
          if (clip.tiktokStatus) {
            initial[clip.id] = {
              state: clip.tiktokStatus,
              publishId: clip.tiktokPublishId || undefined,
            };
          }
        });
        setTtState(initial);
      }
    } catch {
      setError("Error fetching video");
    } finally {
      setLoading(false);
    }
  }

  async function sendToTikTok(clipId: string) {
    setError(null);
    setSending((prev) => ({ ...prev, [clipId]: true }));
    try {
      const response = await fetch(`/api/tiktok/clip/${clipId}/post`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "draft" }),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => null);
        if (data && data.error) {
          setError(data.error);
        } else {
          setError("Failed to send to TikTok");
        }
        setTtState((prev) => ({ ...prev, [clipId]: { state: "failed" } }));
        setSending((prev) => ({ ...prev, [clipId]: false }));
        return;
      }
      const posted = await response.json().catch(() => ({} as any));
      if (posted?.publishId) {
        setTtState((prev) => ({
          ...prev,
          [clipId]: { state: "uploading", publishId: posted.publishId },
        }));
      } else {
        setTtState((prev) => ({ ...prev, [clipId]: { state: "uploading" } }));
      }
      const poll = async () => {
        const statusRes = await fetch(`/api/tiktok/clip/${clipId}/status`);
        if (statusRes.ok) {
          const data = await statusRes.json();
          if (data?.tiktokStatus) {
            setTtState((prev) => ({
              ...prev,
              [clipId]: {
                state: data.tiktokStatus,
                publishId: data.publishId || prev[clipId]?.publishId,
              },
            }));
            if (data.tiktokStatus === "draft") {
              setSending((prev) => ({ ...prev, [clipId]: false }));
              return;
            }
            if (data.tiktokStatus === "failed") {
              setSending((prev) => ({ ...prev, [clipId]: false }));
              return;
            }
            if (data.tiktokStatus === "published") {
              setSending((prev) => ({ ...prev, [clipId]: false }));
              return;
            }
          }
        }
        setTimeout(poll, 2000);
      };
      poll();
    } catch {
      setError("Failed to send to TikTok");
      setTtState((prev) => ({ ...prev, [clipId]: { state: "failed" } }));
      setSending((prev) => ({ ...prev, [clipId]: false }));
    }
  }

  async function deleteClip(clipId: string) {
    setError(null);
    const ok = window.confirm("Delete this clip?");
    if (ok) {
      setDeleting((prev) => ({ ...prev, [clipId]: true }));
      try {
        const res = await fetch(`/api/clips/${clipId}`, { method: "DELETE" });
        if (!res.ok) {
          const data = await res.json().catch(() => null);
          if (data && data.error) {
            setError(data.error);
          } else {
            setError("Failed to delete clip");
          }
          setDeleting((prev) => ({ ...prev, [clipId]: false }));
          return;
        }
        setVideo((prev) => {
          if (!prev) {
            return prev;
          }
          return {
            ...prev,
            clips: prev.clips.filter((c) => {
              if (c.id !== clipId) {
                return true;
              }
              return false;
            }),
          };
        });
        setSending((prev) => {
          const next = { ...prev };
          delete next[clipId];
          return next;
        });
        setTtState((prev) => {
          const next = { ...prev };
          delete next[clipId];
          return next;
        });
        setDeleting((prev) => {
          const next = { ...prev };
          delete next[clipId];
          return next;
        });
      } catch {
        setError("Failed to delete clip");
        setDeleting((prev) => ({ ...prev, [clipId]: false }));
      }
    }
  }

  async function updateSubtitles(clipId: string) {
    setError(null);
    setUpdating((prev) => ({ ...prev, [clipId]: true }));
    try {
      const wordCount = wordsPerSubtitle[clipId] || 1;
      const res = await fetch(`/api/clips/${clipId}/update-subs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wordsPerSubtitle: wordCount }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        if (data && data.error) {
          setError(data.error);
        } else {
          setError("Failed to update subtitles");
        }
        setUpdating((prev) => ({ ...prev, [clipId]: false }));
        return;
      }
      const id = video?.id || "";
      if (id) {
        await fetchVideo(id);
      }
      setUpdating((prev) => ({ ...prev, [clipId]: false }));
    } catch {
      setError("Failed to update subtitles");
      setUpdating((prev) => ({ ...prev, [clipId]: false }));
    }
  }

  async function centerClip(clipId: string) {
    setError(null);
    setCentering((prev) => ({ ...prev, [clipId]: true }));
    try {
      const res = await fetch(`/api/clips/${clipId}/center`, {
        method: "POST",
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        if (data && data.error) {
          setError(data.error);
        } else {
          setError("Failed to center the video");
        }
        setCentering((prev) => ({ ...prev, [clipId]: false }));
        return;
      }
      const id = video?.id || "";
      if (id) {
        await fetchVideo(id);
      }
      setCentering((prev) => ({ ...prev, [clipId]: false }));
    } catch {
      setError("Failed to center the video");
      setCentering((prev) => ({ ...prev, [clipId]: false }));
    }
  }

  function openMenu(clipId: string, el: HTMLElement) {
    setActionMenu((prev) => ({ ...prev, [clipId]: el }));
  }

  function closeMenu(clipId: string) {
    setActionMenu((prev) => ({ ...prev, [clipId]: null }));
  }

  if (loading) {
    return (
      <Box
        minHeight="100vh"
        display="grid"
        alignItems="center"
        justifyContent="center"
        gap={2}
      >
        <CircularProgress />
        <Typography variant="body2" color="text.secondary">
          Loading video…
        </Typography>
      </Box>
    );
  }

  if (!video) {
    return (
      <Box minHeight="100vh" display="grid" sx={{ placeItems: "center" }}>
        <Stack spacing={2} alignItems="center">
          <Typography variant="h6">Video not found</Typography>
          <Button href="/" component={Link}>
            Back to all videos
          </Button>
        </Stack>
      </Box>
    );
  }

  return (
    <Box minHeight="100vh" display="flex" flexDirection="column">
      <AppBar position="sticky">
        <Toolbar sx={{ gap: 1 }}>
          <Tooltip title="Back">
            <IconButton
              edge="start"
              color="inherit"
              onClick={() => router.push("/")}
            >
              <ArrowBackIcon />
            </IconButton>
          </Tooltip>
          <Typography
            variant="h6"
            sx={{
              ml: 1,
              flexGrow: 1,
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {video.title}
          </Typography>
          <Button href="/" component={Link} color="primary">
            All Videos
          </Button>
        </Toolbar>
        {isProcessing && <LinearProgress />}
      </AppBar>

      <Container sx={{ py: 4, flex: 1 }}>
        {error && (
          <Alert severity="error" sx={{ mb: 3 }}>
            {error}
          </Alert>
        )}

        <Paper sx={{ p: 2, mb: 2 }}>
          <Stack spacing={2}>
            <Stack direction={{ xs: "column", md: "row" }} spacing={2}>
              <Paper sx={{ p: 1.25, flex: 1 }}>
                <Tabs
                  value={tabCategory}
                  onChange={(_, v) => {
                    setTabCategory(v);
                    const cat = categories[v] || "all";
                    setSelectedCategory(cat);
                  }}
                  variant="scrollable"
                  scrollButtons="auto"
                >
                  {categories.map((c) => (
                    <Tab key={c} label={c === "all" ? "All" : c} />
                  ))}
                </Tabs>
              </Paper>

              <Paper
                sx={{
                  p: 1.25,
                  display: "flex",
                  alignItems: "center",
                  gap: 1.5,
                  flexWrap: "wrap",
                }}
              >
                <TextField
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  size="small"
                  placeholder="Search tags, rationale, category"
                  InputProps={{
                    startAdornment: (
                      <InputAdornment position="start">
                        <SearchIcon fontSize="small" />
                      </InputAdornment>
                    ),
                  }}
                  sx={{ minWidth: 260, flex: 2 }}
                />
                <FormControl size="small" sx={{ minWidth: 160 }}>
                  <InputLabel id="sort-key">Sort</InputLabel>
                  <Select
                    labelId="sort-key"
                    label="Sort"
                    value={sortKey}
                    onChange={(e) => setSortKey(e.target.value as SortKey)}
                  >
                    <MenuItem value="score">Score</MenuItem>
                    <MenuItem value="duration">Duration</MenuItem>
                    <MenuItem value="start">Start time</MenuItem>
                  </Select>
                </FormControl>
                <ToggleButtonGroup
                  size="small"
                  value={sortDir}
                  exclusive
                  onChange={(_, v) => {
                    if (v) {
                      setSortDir(v);
                    }
                  }}
                >
                  <ToggleButton value="asc">Asc</ToggleButton>
                  <ToggleButton value="desc">Desc</ToggleButton>
                </ToggleButtonGroup>
              </Paper>
            </Stack>

            <Paper sx={{ p: 1.5 }}>
              <Stack spacing={1.25}>
                <Stack
                  direction="row"
                  spacing={1}
                  alignItems="center"
                  justifyContent="space-between"
                  flexWrap="wrap"
                >
                  <Stack direction="row" spacing={1} flexWrap="wrap">
                    <Chip
                      size="small"
                      label="Any"
                      color={scorePreset === "any" ? "primary" : undefined}
                      variant={scorePreset === "any" ? "filled" : "outlined"}
                      onClick={() => setScorePreset("any")}
                    />
                    <Chip
                      size="small"
                      label="60+"
                      color={scorePreset === "60" ? "primary" : undefined}
                      variant={scorePreset === "60" ? "filled" : "outlined"}
                      onClick={() => setScorePreset("60")}
                    />
                    <Chip
                      size="small"
                      label="70+"
                      color={scorePreset === "70" ? "primary" : undefined}
                      variant={scorePreset === "70" ? "filled" : "outlined"}
                      onClick={() => setScorePreset("70")}
                    />
                    <Chip
                      size="small"
                      label="80+"
                      color={scorePreset === "80" ? "primary" : undefined}
                      variant={scorePreset === "80" ? "filled" : "outlined"}
                      onClick={() => setScorePreset("80")}
                    />
                    <Chip
                      size="small"
                      label="90+"
                      color={scorePreset === "90" ? "primary" : undefined}
                      variant={scorePreset === "90" ? "filled" : "outlined"}
                      onClick={() => setScorePreset("90")}
                    />
                  </Stack>

                  <Stack
                    direction="row"
                    spacing={2}
                    alignItems="center"
                    sx={{ minWidth: 260, flex: 1 }}
                  >
                    <Typography
                      variant="caption"
                      sx={{ minWidth: 90, textAlign: "right" }}
                    >
                      Score range
                    </Typography>
                    <Slider
                      value={scoreRange}
                      onChange={(_, v) => {
                        const val = v as number[];
                        setScoreRange([
                          Math.min(val[0], val[1]),
                          Math.max(val[0], val[1]),
                        ]);
                        setScorePreset("any");
                      }}
                      min={0}
                      max={100}
                      step={1}
                      valueLabelDisplay="auto"
                      disableSwap
                      sx={{ flex: 1 }}
                    />
                  </Stack>
                </Stack>
              </Stack>
            </Paper>

            <Paper
              sx={{
                p: 1.25,
                display: "grid",
                gridTemplateColumns: { xs: "1fr", sm: "repeat(3,1fr)" },
                gap: 1.5,
              }}
            >
              <Stack spacing={0.25} alignItems="center">
                <Typography variant="caption" color="text.secondary">
                  Status
                </Typography>
                <Chip
                  size="small"
                  label={video.status}
                  color={
                    video.status === "completed"
                      ? "success"
                      : video.status === "processing"
                      ? "warning"
                      : video.status === "failed"
                      ? "error"
                      : "default"
                  }
                />
              </Stack>
              <Stack spacing={0.25} alignItems="center">
                <Typography variant="caption" color="text.secondary">
                  Duration
                </Typography>
                <Stack direction="row" spacing={1} alignItems="center">
                  <AccessTimeIcon fontSize="small" />
                  <Box>{Math.floor(video.durationSec / 60)}m</Box>
                </Stack>
              </Stack>
              <Stack spacing={0.25} alignItems="center">
                <Typography variant="caption" color="text.secondary">
                  Clips
                </Typography>
                <Stack direction="row" spacing={3} alignItems="center">
                  <QueryStatsIcon fontSize="small" />
                  <Badge color="primary" badgeContent={video.clips.length} />
                </Stack>
              </Stack>
            </Paper>
          </Stack>
        </Paper>

        <Box
          display="grid"
          gridTemplateColumns={{ xs: "1fr", sm: "1fr 1fr", lg: "1fr 1fr 1fr" }}
          gap={3}
        >
          {filteredClips.map((clip) => {
            const state = ttState[clip.id]?.state;
            const publishId = ttState[clip.id]?.publishId;
            const menuOpen = Boolean(actionMenu[clip.id]);
            const busy = Boolean(updating[clip.id] || centering[clip.id]);

            return (
              <Card
                key={clip.id}
                sx={{
                  display: "flex",
                  flexDirection: "column",
                  height: "100%",
                  position: "relative",
                  overflow: "hidden",
                }}
                elevation={1}
              >
                {busy && (
                  <Box
                    sx={{
                      position: "absolute",
                      inset: 0,
                      bgcolor: "rgba(37,99,235,0.12)",
                      zIndex: 3,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      flexDirection: "column",
                      backdropFilter: "blur(2px)",
                    }}
                  >
                    <CircularProgress size={28} sx={{ mb: 1 }} />
                    <Typography variant="body2">
                      {updating[clip.id]
                        ? "Updating subtitles…"
                        : "Reframing video…"}
                    </Typography>
                  </Box>
                )}

                <Box
                  sx={{
                    px: 2,
                    py: 1,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                  }}
                >
                  <Stack
                    direction="row"
                    spacing={1}
                    alignItems="center"
                    flexWrap="wrap"
                  >
                    <Chip size="small" label={clip.category} />
                    <Chip
                      size="small"
                      icon={<SpeedIcon fontSize="small" />}
                      label={`${clip.durationSec}s`}
                      variant="outlined"
                    />
                  </Stack>
                  <Chip
                    size="small"
                    sx={scoreChipSx(clip.scoreOverall)}
                    label={clip.scoreOverall}
                  />
                </Box>

                <CardMedia
                  component="video"
                  controls
                  poster={clip.thumbUrl}
                  src={clip.videoUrl}
                  sx={{
                    aspectRatio: "9/16",
                    objectFit: "cover",
                    bgcolor: "black",
                  }}
                />

                <CardContent
                  sx={{
                    display: "flex",
                    flexDirection: "column",
                    gap: 1.25,
                    flexGrow: 1,
                  }}
                >
                  <Stack direction="row" spacing={1} flexWrap="wrap">
                    {clip.tags.map((t, i) => (
                      <Chip
                        key={`${clip.id}-tag-${i}`}
                        size="small"
                        label={t}
                        variant="outlined"
                      />
                    ))}
                  </Stack>

                  <Stack
                    direction="row"
                    spacing={2}
                    flexWrap="wrap"
                    sx={{ color: "text.secondary" }}
                  >
                    <Box>Hook: {clip.scoreHook}/10</Box>
                    <Box>Retention: {clip.scoreRetention}/10</Box>
                    <Box>Clarity: {clip.scoreClarity}/10</Box>
                    <Box>Share: {clip.scoreShare}/10</Box>
                  </Stack>

                  <Typography
                    variant="body2"
                    sx={{
                      display: "-webkit-box",
                      overflow: "hidden",
                      WebkitLineClamp: 3,
                      WebkitBoxOrient: "vertical",
                      minHeight: 60,
                    }}
                  >
                    {clip.rationale}
                  </Typography>

                  <Stack
                    direction="row"
                    spacing={1}
                    alignItems="center"
                    sx={{ color: "text.secondary" }}
                  >
                    <AccessTimeIcon fontSize="small" />
                    <Typography variant="caption">
                      {Math.floor(clip.startSec)}s – {Math.floor(clip.endSec)}s
                    </Typography>
                    <Typography variant="caption" sx={{ ml: 0.5 }}>
                      ({clip.durationSec}s)
                    </Typography>
                  </Stack>

                  <Stack direction="row" spacing={1} alignItems="center">
                    <Typography variant="caption" color="text.secondary">
                      TikTok:
                    </Typography>
                    <Typography
                      variant="caption"
                      color={
                        state === "published"
                          ? "success.main"
                          : state === "failed"
                          ? "error.main"
                          : state === "draft"
                          ? "warning.main"
                          : state === "uploading"
                          ? "info.main"
                          : "text.secondary"
                      }
                    >
                      {state || "—"}
                    </Typography>
                    {publishId && (
                      <Typography variant="caption" color="text.secondary">
                        ({publishId})
                      </Typography>
                    )}
                  </Stack>

                  <Stack
                    direction="row"
                    alignItems="center"
                    justifyContent="space-between"
                    sx={{ mt: "auto" }}
                  >
                    <Button
                      onClick={() => sendToTikTok(clip.id)}
                      disabled={
                        Boolean(sending[clip.id]) ||
                        ttState[clip.id]?.state === "published" ||
                        busy
                      }
                      color="secondary"
                      fullWidth
                      sx={{ mr: 1 }}
                    >
                      {sending[clip.id] ? "Sending…" : "Send to TikTok"}
                    </Button>

                    <IconButton
                      onClick={(e) => openMenu(clip.id, e.currentTarget)}
                      disabled={
                        Boolean(sending[clip.id]) || Boolean(deleting[clip.id])
                      }
                      sx={{ zIndex: 4 }}
                    >
                      <MoreVertIcon />
                    </IconButton>

                    <Menu
                      anchorEl={actionMenu[clip.id] || null}
                      open={menuOpen}
                      onClose={() => closeMenu(clip.id)}
                      anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
                      transformOrigin={{ vertical: "top", horizontal: "right" }}
                    >
                      <Box sx={{ px: 2, py: 1 }}>
                        <Typography variant="caption" color="text.secondary">
                          Words per subtitle
                        </Typography>
                        <Select
                          size="small"
                          value={wordsPerSubtitle[clip.id] || 1}
                          onChange={(e) => {
                            setWordsPerSubtitle((prev) => ({
                              ...prev,
                              [clip.id]: Number(e.target.value),
                            }));
                          }}
                          fullWidth
                          sx={{ mt: 0.5 }}
                        >
                          <MenuItem value={1}>1 word</MenuItem>
                          <MenuItem value={2}>2 words</MenuItem>
                          <MenuItem value={3}>3 words</MenuItem>
                          <MenuItem value={4}>4 words</MenuItem>
                          <MenuItem value={5}>5 words</MenuItem>
                        </Select>
                      </Box>
                      <MenuItem
                        onClick={() => {
                          closeMenu(clip.id);
                          updateSubtitles(clip.id);
                        }}
                        disabled={Boolean(updating[clip.id])}
                      >
                        <ListItemIcon>
                          <SubtitlesIcon fontSize="small" />
                        </ListItemIcon>
                        <ListItemText
                          primary={
                            updating[clip.id] ? "Updating…" : "Update Subtitles"
                          }
                        />
                      </MenuItem>

                      <MenuItem
                        onClick={() => {
                          closeMenu(clip.id);
                          centerClip(clip.id);
                        }}
                        disabled={
                          Boolean(centering[clip.id]) ||
                          Boolean(sending[clip.id]) ||
                          Boolean(deleting[clip.id])
                        }
                      >
                        <ListItemIcon>
                          <CenterFocusStrongIcon fontSize="small" />
                        </ListItemIcon>
                        <ListItemText
                          primary={
                            centering[clip.id] ? "Reframing…" : "Reframe"
                          }
                        />
                      </MenuItem>

                      <Divider />

                      <MenuItem
                        component="a"
                        href={clip.videoUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={() => closeMenu(clip.id)}
                      >
                        <ListItemIcon>
                          <MovieIcon fontSize="small" />
                        </ListItemIcon>
                        <ListItemText primary="Open Video" />
                      </MenuItem>

                      <MenuItem
                        component="a"
                        href={clip.srtUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={() => closeMenu(clip.id)}
                      >
                        <ListItemIcon>
                          <DescriptionIcon fontSize="small" />
                        </ListItemIcon>
                        <ListItemText primary="Open SRT" />
                      </MenuItem>

                      <Divider />

                      <MenuItem
                        onClick={() => {
                          closeMenu(clip.id);
                          deleteClip(clip.id);
                        }}
                        disabled={Boolean(deleting[clip.id])}
                        sx={{ color: "error.main" }}
                      >
                        <ListItemIcon>
                          <DeleteOutlineIcon fontSize="small" color="error" />
                        </ListItemIcon>
                        <ListItemText
                          primary={deleting[clip.id] ? "Deleting…" : "Delete"}
                        />
                      </MenuItem>
                    </Menu>
                  </Stack>
                </CardContent>
              </Card>
            );
          })}
        </Box>

        {filteredClips.length === 0 && (
          <Box py={8} textAlign="center" color="text.secondary">
            <Stack spacing={2} alignItems="center">
              <Typography variant="h6">No clips match your filters</Typography>
              <Typography variant="body2">
                Try adjusting the score, category, or search query
              </Typography>
              <Button
                variant="outlined"
                onClick={() => {
                  setSelectedCategory("all");
                  setScoreRange([0, 100]);
                  setScorePreset("any");
                  setQuery("");
                  setTabCategory(0);
                }}
              >
                Reset filters
              </Button>
            </Stack>
          </Box>
        )}
      </Container>
    </Box>
  );
}
