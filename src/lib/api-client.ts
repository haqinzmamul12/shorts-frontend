export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export interface ImageCandidate {
  url: string;
  title: string;
  description: string;
  category: string;
  license: string;
  source_page: string;
  width: number;
  height: number;
}

export interface ImageSelectionInterrupt {
  type: string;
  block_index: number;
  narration_text: string;
  image_keyword: string;
  candidates: ImageCandidate[];
}

const BACKEND_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

async function requestWithTimeout<T>(
  url: string,
  options: RequestInit = {},
  timeoutMs: number = 300000
): Promise<T> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  const headers: Record<string, string> = {
    ...(options.headers as Record<string, string>),
  };
  if (!(options.body instanceof FormData)) {
    headers["Content-Type"] = headers["Content-Type"] || "application/json";
  }

  try {
    const res = await fetch(url, { ...options, headers, signal: controller.signal });
    clearTimeout(timeoutId);

    if (!res.ok) {
      let msg = res.statusText;
      try {
        const data = await res.json();
        msg = data.detail || data.message || msg;
      } catch (e) { /* ignore */ }
      throw new ApiError(res.status, msg);
    }

    if (res.status === 204) return undefined as T;
    return res.json();
  } catch (error) {
    clearTimeout(timeoutId);
    if (error instanceof ApiError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new ApiError(0, `Request timed out after ${timeoutMs / 1000}s`);
    }
    const detail = error instanceof Error ? ` Details: ${error.message}` : "";
    throw new ApiError(0, `Backend unavailable at ${BACKEND_URL}. Is the server running?${detail}`);
  }
}

export const api = {
  health: () => requestWithTimeout<{ status: string; version: string }>(`${BACKEND_URL}/api/health`),

  fetchTrends: (topic: string, limit: number = 10, language: "english" | "hindi" = "english", duration: number = 30) =>
    requestWithTimeout<{
      success: boolean;
      data?: {
        topic_title: string;
        target_niche: string;
        hook_text: string;
        narration_blocks: Array<{
          timestamp: string;
          text: string;
          image_keyword: string;
          queries: string[];
          image_url?: string;
        }>;
        video_metadata: {
          title: string;
          description: string;
          hashtags: string[];
        };
      };
      error?: string;
    }>(`${BACKEND_URL}/api/fetch-trends`, {
      method: "POST",
      body: JSON.stringify({ topic, limit, language, duration }),
    }, 120000),

  animateAssets: (scriptPath: string, selectedImages?: Record<string, string>) =>
    requestWithTimeout<{
      success: boolean;
      data?: {
        run_id: string;
        voiceover_url: string;
        enhanced_assets: Array<{
          block_index: number;
          source_image_url: string;
          enhanced_background_url: string;
          enhanced_foreground_url: string;
          highlight_text: string;
          image_metadata: Record<string, unknown>;
          all_candidates: Array<Record<string, unknown>>;
        }>;
        narration_blocks_count: number;
        images_processed: number;
        script_id: string | null;
        script_path: string;
        narration_blocks: Array<Record<string, unknown>>;
        created_at: string;
        manifest_url: string;
        status: string;
        blocks_awaiting_selection?: Array<{
          block_index: number;
          narration_text: string;
          image_keyword: string;
          queries: string[];
          candidates: Array<{
            url: string;
            title: string;
            description: string;
            category: string;
            license: string;
            source_page: string;
            width: number;
            height: number;
          }>;
        }>;
      };
      error?: string;
    }>(`${BACKEND_URL}/api/animate-assets`, {
      method: "POST",
      body: JSON.stringify({ script_path: scriptPath, selected_images: selectedImages }),
    }, 300000),

  assembleVideo: (manifestPath: string, waitForCompletion: boolean = true) =>
    requestWithTimeout<{
      success: boolean;
      data?: {
        run_id: string;
        render_id: string;
        status: string;
        video_url: string | null;
        created_at: string;
        provider: string;
      };
      error?: string;
    }>(`${BACKEND_URL}/api/assemble-video`, {
      method: "POST",
      body: JSON.stringify({ manifest_path: manifestPath, wait_for_completion: waitForCompletion }),
    }, 300000),

  runPipeline: (topic: string, limit: number = 10, language: "english" | "hindi" = "english", duration: number = 30) => {
    const params = new URLSearchParams({ topic, limit: String(limit), language, duration: String(duration) });
    return requestWithTimeout<{
      success: boolean;
      data?: {
        status: string;
        thread_id: string;
        interrupt?: {
          type: string;
          block_index: number;
          narration_text: string;
          image_keyword: string;
          candidates: ImageCandidate[];
        } | null;
        render_id: string;
        video_url: string;
        run_id: string;
        provider: string;
        steps: {
          fetch_trends: { status: string; data?: unknown };
          animate_assets: { status: string; data?: unknown };
          assemble_video: { status: string; data?: unknown };
        };
        error?: string;
      };
      error?: string;
    }>(`${BACKEND_URL}/api/run-pipeline?${params.toString()}`, { method: "POST" }, 600000);
  },

  pipelineStatus: (runId: string) =>
    requestWithTimeout<{
      success: boolean;
      data?: {
        status: string;
        thread_id: string;
        current_node: string;
        completed_nodes: string[];
        run_id: string;
        render_id?: string;
        video_url?: string;
        error?: string;
        awaiting_human_image?: {
          block_index: number;
          narration_text: string;
          image_keyword: string;
          queries: string[];
        };
        awaiting_image_selection?: {
          block_index: number;
          narration_text: string;
          image_keyword: string;
          candidates: Array<{
            url: string;
            title: string;
            description: string;
            category: string;
            license: string;
            source_page: string;
            width: number;
            height: number;
          }>;
        };
        interrupt?: {
          type: string;
          block_index: number;
          narration_text: string;
          image_keyword: string;
          candidates: ImageCandidate[];
        } | null;
      };
      error?: string;
    }>(`${BACKEND_URL}/api/pipeline-status/${runId}`, { method: "GET" }, 10000),

  resumePipelineSelection: (runId: string, blockIndex: number, selectedImageUrl: string) =>
    requestWithTimeout<{
      success: boolean;
      data?: {
        status: string;
        thread_id: string;
        run_id: string;
        render_id: string;
        video_url: string;
        interrupt?: {
          type: string;
          block_index: number;
          narration_text: string;
          image_keyword: string;
          candidates: ImageCandidate[];
        } | null;
        error?: string;
      };
      error?: string;
    }>(`${BACKEND_URL}/api/resume-pipeline-selection/${runId}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ block_index: String(blockIndex), selected_image_url: selectedImageUrl }),
    }, 600000),
};