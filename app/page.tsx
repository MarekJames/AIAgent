"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  AppBar,
  Toolbar,
  Typography,
  Box,
  Container,
  Stack,
  Button,
  Chip,
  Paper,
  TextField,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Checkbox,
  IconButton,
  Menu,
  MenuItem,
  TablePagination,
  Divider,
  Alert,
  CircularProgress,
} from "@mui/material";
import MoreVertIcon from "@mui/icons-material/MoreVert";

interface Video {
  id: string;
  title: string;
  sourceUrl: string;
  status: string;
  durationSec: number;
  createdAt: string;
  _count: { clips: number };
}

export default function Home() {
  const router = useRouter();
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [videos, setVideos] = useState<Video[]>([]);
  const [error, setError] = useState("");
  const [authStatus, setAuthStatus] = useState<any>(null);
  const [connections, setConnections] = useState<any>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [deletingBatch, setDeletingBatch] = useState(false);
  const [page, setPage] = useState(0);
  const [rowsPerPage, setRowsPerPage] = useState(10);
  const [total, setTotal] = useState(0);
  const [menuAnchor, setMenuAnchor] = useState<null | HTMLElement>(null);
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);

  useEffect(() => {
    checkAuth();
  }, []);

  useEffect(() => {
    if (authStatus && connections) {
      fetchVideos(page + 1, rowsPerPage);
    }
  }, [page, rowsPerPage, authStatus, connections]);

  async function checkAuth() {
    try {
      const res = await fetch("/api/auth/status");
      const data = await res.json();
      setAuthStatus(data);
      if (!data.isAuthenticated) {
        router.push("/login");
        return;
      }
      const connectionsRes = await fetch("/api/me/connections");
      const connectionsData = await connectionsRes.json();
      setConnections(connectionsData);
      fetchVideos(1, rowsPerPage);
    } catch {
      router.push("/login");
    }
  }

  async function fetchVideos(p = 1, ps = 10) {
    try {
      const response = await fetch(`/api/videos?page=${p}&pageSize=${ps}`);
      const data = await response.json();
      if (response.ok) {
        setVideos(data.videos);
        setTotal(data.total);
        setSelectedIds([]);
        setOpenMenuId(null);
        setMenuAnchor(null);
      }
    } catch {}
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      const data = await response.json();
      if (response.ok) {
        setUrl("");
        setPage(0);
        fetchVideos(1, rowsPerPage);
      } else {
        setError(data.error || "Failed to submit video");
      }
    } catch {
      setError("Failed to submit video");
    } finally {
      setLoading(false);
    }
  }

  async function handleLogout() {
    try {
      await fetch("/api/auth/logout", { method: "POST" });
      router.push("/login");
    } catch {}
  }

  async function handleCancel(videoId: string) {
    const ok = window.confirm("Cancel this video processing?");
    if (ok) {
      try {
        const response = await fetch(`/api/videos/${videoId}/cancel`, {
          method: "POST",
        });
        if (response.ok) {
          fetchVideos(page + 1, rowsPerPage);
        } else {
          const data = await response.json();
          alert(data.error || "Failed to cancel video");
        }
      } catch {
        alert("Failed to cancel video");
      }
    }
  }

  async function handleDelete(videoId: string) {
    const ok = window.confirm("Delete this video and all associated clips?");
    if (ok) {
      setDeletingId(videoId);
      setError("");
      try {
        const res = await fetch(`/api/videos/${videoId}`, { method: "DELETE" });
        const data = await res.json().catch(() => ({}));
        if (res.ok) {
          const nextTotal = Math.max(0, total - 1);
          const maxPage = Math.max(0, Math.ceil(nextTotal / rowsPerPage) - 1);
          const nextPage = Math.min(page, maxPage);
          setPage(nextPage);
          fetchVideos(nextPage + 1, rowsPerPage);
        } else {
          setError(data.error || "Failed to delete video");
        }
      } catch {
        setError("Failed to delete video");
      } finally {
        setDeletingId(null);
        setOpenMenuId(null);
        setMenuAnchor(null);
      }
    }
  }

  function toggleOne(id: string) {
    setSelectedIds((prev) => {
      if (prev.includes(id)) {
        return prev.filter((x) => x !== id);
      }
      return [...prev, id];
    });
  }

  function toggleAll() {
    if (selectedIds.length === videos.length) {
      setSelectedIds([]);
      return;
    }
    setSelectedIds(videos.map((v) => v.id));
  }

  async function handleBatchDelete() {
    if (selectedIds.length === 0) {
      return;
    }
    const ok = window.confirm(
      `Delete ${selectedIds.length} video(s) and all associated clips?`,
    );
    if (ok) {
      setDeletingBatch(true);
      setError("");
      try {
        const res = await fetch(`/api/videos/batch-delete`, {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ids: selectedIds }),
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok) {
          const newTotal = Math.max(0, total - selectedIds.length);
          const maxPage = Math.max(0, Math.ceil(newTotal / rowsPerPage) - 1);
          const nextPage = Math.min(page, maxPage);
          setPage(nextPage);
          fetchVideos(nextPage + 1, rowsPerPage);
        } else {
          setError(data.error || "Failed to delete selected videos");
        }
      } catch {
        setError("Failed to delete selected videos");
      } finally {
        setDeletingBatch(false);
        setOpenMenuId(null);
        setMenuAnchor(null);
      }
    }
  }

  const pageCount = useMemo(
    () => Math.max(1, Math.ceil(total / rowsPerPage)),
    [total, rowsPerPage],
  );
  const loadingGate = !authStatus || !connections;

  if (loadingGate) {
    return (
      <Box sx={{ minHeight: "100vh", display: "grid", placeItems: "center" }}>
        <CircularProgress />
      </Box>
    );
  }

  return (
    <Box minHeight="100vh" display="flex" flexDirection="column">
      <AppBar position="sticky">
        <Toolbar>
          <Typography variant="h5" sx={{ flexGrow: 1 }}>
            YT Shortsmith
          </Typography>
          <Stack direction="row" spacing={1} alignItems="center">
            <Chip
              size="small"
              color={connections.hasYouTube ? "success" : "error"}
              label={
                connections.hasYouTube ? "YouTube Connected" : "YouTube Disconnected"
              }
            />
            <Chip
              size="small"
              color={connections.hasTikTok ? "success" : "error"}
              label={
                connections.hasTikTok
                  ? "TikTok Connected"
                  : "TikTok Disconnected"
              }
            />
            <Button
              href="/upload-cookies"
              color="inherit"
              variant="outlined"
            >
              Manage Cookies
            </Button>
            <Button href="/api/tiktok/oauth/start">
              {connections.hasTikTok ? "Reconnect TikTok" : "Connect TikTok"}
            </Button>
            <Button onClick={handleLogout} color="inherit">
              Logout
            </Button>
          </Stack>
        </Toolbar>
      </AppBar>

      <Container sx={{ py: 4, flex: 1 }}>
        {!connections.hasYouTube && (
          <Alert severity="warning" sx={{ mb: 3 }}>
            YouTube not connected. Please contact administrator to connect YouTube OAuth.
          </Alert>
        )}
        
        {!connections.hasCookies && (
          <Alert severity="warning" sx={{ mb: 3 }}>
            YouTube cookies not uploaded. Video downloads may fail.{" "}
            <Button
              href="/upload-cookies"
              size="small"
              sx={{ ml: 1 }}
            >
              Upload Cookies
            </Button>
          </Alert>
        )}
        
        {connections.hasCookies && connections.cookieAgeDays > 21 && (
          <Alert severity="info" sx={{ mb: 3 }}>
            YouTube cookies are {connections.cookieAgeDays} days old and may be expired.{" "}
            <Button
              href="/upload-cookies"
              size="small"
              sx={{ ml: 1 }}
            >
              Refresh Cookies
            </Button>
          </Alert>
        )}

        <Paper sx={{ p: 3, mb: 4 }}>
          <Typography variant="h6" sx={{ mb: 2 }}>
            Submit YouTube Video
          </Typography>
          <Box component="form" onSubmit={handleSubmit} display="flex" gap={2}>
            <TextField
              fullWidth
              placeholder="Enter YouTube URL"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              disabled={loading || !connections.hasYouTube}
            />
            <Button
              type="submit"
              disabled={loading || !url || !connections.hasYouTube}
            >
              {loading ? "Submitting…" : "Submit"}
            </Button>
          </Box>
          {error && (
            <Alert severity="error" sx={{ mt: 2 }}>
              {error}
            </Alert>
          )}
        </Paper>

        <Paper sx={{ p: 3 }}>
          <Stack
            direction="row"
            justifyContent="space-between"
            alignItems="center"
            sx={{ mb: 2 }}
          >
            <Typography variant="h6">Videos</Typography>
            <Stack direction="row" spacing={2} alignItems="center">
              <Typography variant="body2" color="text.secondary">
                {selectedIds.length} selected
              </Typography>
              <Button
                color="error"
                disabled={selectedIds.length === 0 || deletingBatch}
                onClick={handleBatchDelete}
              >
                {deletingBatch ? "Deleting…" : "Delete Selected"}
              </Button>
            </Stack>
          </Stack>

          <TableContainer>
            <Table>
              <TableHead>
                <TableRow>
                  <TableCell padding="checkbox">
                    <Checkbox
                      checked={
                        videos.length > 0 &&
                        selectedIds.length === videos.length
                      }
                      indeterminate={
                        selectedIds.length > 0 &&
                        selectedIds.length < videos.length
                      }
                      onChange={toggleAll}
                    />
                  </TableCell>
                  <TableCell>Title</TableCell>
                  <TableCell>Status</TableCell>
                  <TableCell>Clips</TableCell>
                  <TableCell>Duration</TableCell>
                  <TableCell>Created</TableCell>
                  <TableCell align="right">Actions</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {videos.map((video) => (
                  <TableRow key={video.id} hover>
                    <TableCell padding="checkbox">
                      <Checkbox
                        checked={selectedIds.includes(video.id)}
                        onChange={() => toggleOne(video.id)}
                      />
                    </TableCell>
                    <TableCell>
                      <Link href={`/videos/${video.id}`}>
                        <Typography
                          color="primary.main"
                          sx={{ cursor: "pointer" }}
                        >
                          {video.title}
                        </Typography>
                      </Link>
                    </TableCell>
                    <TableCell>
                      <Chip
                        size="small"
                        label={video.status}
                        color={
                          video.status === "completed"
                            ? "success"
                            : video.status === "processing"
                              ? "info"
                              : video.status === "failed"
                                ? "error"
                                : "default"
                        }
                      />
                    </TableCell>
                    <TableCell>{video._count.clips}</TableCell>
                    <TableCell>{Math.floor(video.durationSec / 60)}m</TableCell>
                    <TableCell>
                      {new Date(video.createdAt).toLocaleDateString()}
                    </TableCell>
                    <TableCell align="right">
                      <IconButton
                        onClick={(e) => {
                          setOpenMenuId(video.id);
                          setMenuAnchor(e.currentTarget);
                        }}
                      >
                        <MoreVertIcon />
                      </IconButton>
                      <Menu
                        anchorEl={menuAnchor}
                        open={openMenuId === video.id}
                        onClose={() => {
                          setOpenMenuId(null);
                          setMenuAnchor(null);
                        }}
                      >
                        <MenuItem
                          onClick={() => {
                            setOpenMenuId(null);
                            setMenuAnchor(null);
                            router.push(`/videos/${video.id}`);
                          }}
                        >
                          Open
                        </MenuItem>
                        {video.status === "processing" && (
                          <MenuItem
                            onClick={() => {
                              setOpenMenuId(null);
                              setMenuAnchor(null);
                              handleCancel(video.id);
                            }}
                          >
                            Cancel
                          </MenuItem>
                        )}
                        <Divider />
                        <MenuItem
                          disabled={deletingId === video.id}
                          onClick={() => {
                            setOpenMenuId(null);
                            setMenuAnchor(null);
                            handleDelete(video.id);
                          }}
                          sx={{ color: "error.main" }}
                        >
                          {deletingId === video.id ? "Deleting…" : "Delete"}
                        </MenuItem>
                      </Menu>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {videos.length === 0 && (
              <Box py={6} textAlign="center" color="text.secondary">
                No videos yet. Submit a YouTube URL to get started.
              </Box>
            )}
            <TablePagination
              component="div"
              count={total}
              page={page}
              onPageChange={(_, newPage) => setPage(newPage)}
              rowsPerPage={rowsPerPage}
              onRowsPerPageChange={(e) => {
                setRowsPerPage(parseInt(e.target.value, 10));
                setPage(0);
              }}
              rowsPerPageOptions={[10, 25, 50, 100]}
              labelDisplayedRows={({ page: p }) =>
                `Page ${p + 1} of ${pageCount}`
              }
            />
          </TableContainer>
        </Paper>
      </Container>
    </Box>
  );
}
