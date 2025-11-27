# YT Shortsmith

## Overview
YT Shortsmith is an AI-powered service designed to automate the creation of engaging short-form video clips from YouTube videos. It handles the entire process from downloading and transcribing to intelligently segmenting and formatting videos into 20-60 second vertical clips optimized for social media platforms like TikTok, Instagram Reels, and YouTube Shorts. The project's main purpose is to streamline content repurposing for creators, enabling them to efficiently transform long-form content into high-impact social media assets.

## User Preferences
Preferred communication style: Simple, everyday language.

Code style constraints:
- Never add comments to code
- Always put single if conditions inside brackets with line breaks
- Focus on clean, self-documenting code

**Cost & Resource Management**:
- Maximum 12 clips per video
- Immediate cancellation required to prevent resource waste
- No tolerance for processing beyond cancellation

## System Architecture

### Frontend
The frontend uses Next.js 14 (App Router), TypeScript, and TailwindCSS for a modern, responsive user interface with server-side rendering, featuring a dashboard and video detail pages.

### Backend
The backend is built with Node.js 20 and TypeScript, leveraging a Next.js API layer for REST endpoints and a BullMQ-powered worker process (`src/worker.ts`) for asynchronous video processing.

**Core Processing Pipeline:**
1.  **Job Creation**: User submits a YouTube URL, initiating video record creation and job enqueuing.
2.  **Video Ingestion**: Downloads video metadata and the video content using `yt-dlp`.
3.  **Audio Processing**: Extracts, compresses, and transcribes audio using the Whisper API with word-level timestamps and automatic language detection.
4.  **Comment Mining**: Fetches YouTube comments to detect timestamp hotspots for engagement-aware scoring.
5.  **Intelligent Segmentation**: Segments videos into clips enforced to 60s or 120s duration (±10-15s tolerance), ending at sentence boundaries (punctuation or pauses ≥0.8s) to prevent mid-sentence cuts. Uses voice activity, pauses, scene changes, and multi-factor feature extraction.
6.  **Two-Stage Scoring** (Cost-Optimized):
    - **Stage 1**: All segments scored using rule-based 7-pillar features (hook, watchability, visuals, safety, novelty, coherence, duration fit) - instant and free
    - **Stage 2**: Only top 25 candidates (by rule-based score) sent to GPT-4o for AI overall scoring
    - Result: Maximum 25 GPT-4o calls per video, regardless of segment count (saves ~50% on videos with 50+ segments)
7.  **Diversity Selection**: MMR (Maximal Marginal Relevance) algorithm selects diverse clips to prevent duplicates, ensuring variety in content.
8.  **Final Ranking**: Clips are ranked with S/A/B tier assignment based on geometric mean of pillars, AI overall score, hotspot proximity, and duration preference. Max 12 clips selected with 33% quota for 120s clips.
9.  **Taxonomy Classification**: Auto-categorizes clips by hook type (question, bold, number, contrast, statement, story) and tone (educational, motivational, humor, commentary, etc.).
10. **Clip Generation**: Converts selected segments to a 9:16 vertical format, applies smart cropping (with body-aware framing), adds TikTok-optimized burned-in subtitles (1-5 words per subtitle using Forever Freedom Regular font), hook text overlay, and generates a thumbnail. Assets are uploaded to S3-compatible storage.
11. **Data Storage**: Stores clip metadata, scores, taxonomy, tier, ranking reasons, S3 keys, and crop maps in the database.

**Data Models (Prisma):**
-   `User`: Authentication and user-specific data.
-   `Video`: Source YouTube video metadata, comment hotspot data, and global crop map for consistent framing across all clips.
-   `Clip`: Generated short video clips and their associated data, including rationale and feature vectors.
-   `TikTokConnection`: User TikTok OAuth tokens.

**Core Services:**
-   `framingService.ts`: Global static framing using face-api.js (SSD MobileNet v1) for face detection with pose-detection fallback for full-body tracking. Includes `computeGlobalStaticCrop()` that samples frames across entire video to compute ONE canonical crop position, and `computeCropMapPersonStatic()` that applies this global crop to individual segments. Ensures consistent person-centered framing across all clips from the same video, eliminating black padding and inconsistent positioning issues.
-   `ffmpeg.ts`: Handles video/audio processing (rendering, audio extraction, thumbnail generation).
-   `youtube.ts`: Manages `yt-dlp` operations for YouTube video downloads using cookie-based authentication.
-   `youtube-oauth.ts`: Handles YouTube OAuth token retrieval and management via Replit's YouTube connector for YouTube Data API access.
-   `cookieGenerator.ts`: Manages YouTube cookie storage, age tracking, and expiration monitoring for yt-dlp authentication.
-   `youtube-comments.ts`: Fetches YouTube comments and mines timestamp hotspots for engagement scoring.
-   `segmentation.ts`: Implements 60/120s clip segmentation with sentence boundary detection.
-   `segmentation-v2.ts`: Enhanced segmentation with multi-factor feature extraction, comment hotspot integration, and adaptive duration selection.
-   `openai.ts`: Integrates OpenAI APIs for Whisper transcription and GPT-4o clip scoring, includes isSentenceBoundaryToken helper.
-   `scoring/features.ts`: Computes 7-pillar features (hook, watchability, visuals, safety, novelty, coherence, duration fit).
-   `scoring/clipScorer.ts`: Scores clips using extracted features and multi-factor algorithms.
-   `scoring/clipRanker.ts`: Final ranking with geometric mean blending, S/A/B tier assignment, and reason generation.
-   `scoring/taxonomy.ts`: Classifies clips by hook type and tone based on content analysis.
-   `selection/clipSelector.ts`: MMR diversity selection to prevent duplicate clips.
-   `selection/finalizeRanking.ts`: Selects best clips with duration balancing (33% quota for 120s clips).
-   `s3.ts`: Provides S3 object storage functionalities.
-   `queue.ts`: Configures BullMQ for job orchestration.

### UI/UX Decisions
The application uses Next.js with TailwindCSS to provide a modern, dark-themed interface, ensuring a consistent and visually appealing user experience.

### System Design Choices
-   **Asynchronous Processing**: Utilizes BullMQ and Redis for robust, scalable background job processing.
-   **Modular Architecture**: Services are clearly separated for maintainability.
-   **Prisma ORM**: Simplifies database interactions and schema management.
-   **Global Static Framing**: Two-tier person detection (face-api.js primary, pose-detection fallback) that samples frames across the ENTIRE video, calculates ONE global median position, and applies the same static crop to ALL clips from that video. This ensures consistent framing across all timestamps (1:00, 2:00, 3:00 look identical). Global crop is computed once per video, stored in database, and reused for every clip. Uses correct median calculation (averages two middle values for even-length arrays) to handle balanced multi-person scenarios. Generates person-centered 9:16 crops with z_min = max(targetW/baseW, 1.0) ensuring valid FFmpeg dimensions. For 16:9 videos, z_min = 1.0 prevents zoom-out attempts.
-   **Robust Cancellation**: Implements frequent cancellation checks throughout the worker process to prevent resource waste.
-   **Two-Stage AI Scoring**: Cost-optimized approach that filters segments with rule-based features before GPT-4o scoring, capping AI calls at 25 per video regardless of segment count.
-   **YouTube Cookie Authentication**: Uses browser cookie export for yt-dlp video downloads (OAuth deprecated by yt-dlp as of 2024). Cookies are uploaded via UI and automatically tracked for expiration (21-day warning threshold).
-   **YouTube API OAuth**: Uses Replit's YouTube connector with OAuth 2.0 for YouTube Data API access (comment fetching, metadata).
-   **TikTok Integration**: Supports OAuth-based TikTok publishing with encrypted token management and automatic refresh.

### Static Framing Configuration
Static person-centered framing is configured via environment variables (see `.env.example`):

**Face & Pose Detection:**
- `FACE_CONF=0.5` - Face detection confidence threshold (0-1)
- `POSE_CONF=0.3` - Pose detection confidence threshold (0-1)
- `MIN_DET_AREA=100` - Min detection area in pixels
- `FRAMING_SAMPLE_FPS=12` - Frame extraction rate for analysis

**Global Crop Sampling:**
- Samples 15-second windows at 30-second intervals across entire video
- Aggregates all detections from all samples (continues even if some samples fail)
- Requires minimum 50 total detections across video to succeed
- Computes median position from all aggregated detections for optimal centering

## External Dependencies

**Database:**
-   **PostgreSQL**: Primary data store, managed by Prisma ORM.

**Queue System:**
-   **Redis**: Used by BullMQ for managing asynchronous job queues.

**AI Services:**
-   **OpenAI Whisper API**: For accurate audio transcription and universal language detection.
-   **GPT-4o**: Utilized for intelligent clip scoring, categorization, and rationale generation with TikTok-specific criteria.

**Video Processing Libraries:**
-   **ffmpeg**: The core video and audio manipulation tool.
-   **yt-dlp**: For downloading YouTube videos and extracting metadata.

**Object Storage:**
-   **S3-compatible storage**: Used for storing generated video clips, thumbnails, and SRT files (AWS SDK v3).

**Person Tracking & AI Models:**
-   **@vladmandic/face-api**: Production-ready face detection library using SSD MobileNet v1 for primary person detection.
-   **@tensorflow-models/pose-detection**: MoveNet-based pose estimation for full-body detection fallback when faces are not visible.
-   **@tensorflow/tfjs-node**: TensorFlow backend for image preprocessing and tensor operations.

**Social Media Integration:**
-   **TikTok API**: For OAuth-based video publishing and user authentication.

**YouTube Integration:**
-   **Replit YouTube Connector**: OAuth 2.0 authentication for yt-dlp video downloads with automatic token management and refresh.
-   **YouTube Data API v3**: For fetching comments and mining timestamp hotspots for engagement scoring.