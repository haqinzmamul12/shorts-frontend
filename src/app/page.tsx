"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import {
  Activity,
  ArrowDownToLine,
  ArrowUpRight,
  Check,
  Circle,
  CircleAlert,
  Clapperboard,
  Clock3,
  Copy,
  Film,
  Gauge,
  History,
  LoaderCircle,
  Play,
  Settings2,
  Sparkles,
  Upload,
  X,
} from "lucide-react";
import { api, type ImageCandidate } from "@/lib/api-client";

type PipelineStepId = "fetch_trends" | "animate_assets" | "assemble_video";
type PipelineStepStatus = "pending" | "active" | "completed" | "failed";

interface PipelineStepDefinition {
  id: PipelineStepId;
  title: string;
  description: string;
}

interface PipelineResult {
  status: string;
  render_id: string;
  video_url: string | null;
  run_id: string;
  provider: string;
  steps?: Partial<Record<PipelineStepId, { status: string; data?: unknown }>>;
}

interface ImageSelectionPrompt {
  type?: string;
  block_index: number;
  narration_text: string;
  image_keyword: string;
  candidates: ImageCandidate[];
}

interface PipelineStatusData {
  status: string;
  current_node: string;
  completed_nodes: string[];
  run_id: string;
  thread_id: string;
  render_id?: string;
  video_url?: string;
  error?: string;
  awaiting_human_image?: {
    block_index: number;
    narration_text: string;
    image_keyword: string;
    queries: string[];
  };
  awaiting_image_selection?: ImageSelectionPrompt;
  interrupt?: ImageSelectionPrompt | null;
}

const pipelineSteps: PipelineStepDefinition[] = [
  {
    id: "fetch_trends",
    title: "Shape the story",
    description:
      "Find a hook and turn your topic into a narration-ready script.",
  },
  {
    id: "animate_assets",
    title: "Build the visuals",
    description: "Create voiceover and prepare imagery for each story beat.",
  },
  {
    id: "assemble_video",
    title: "Render the short",
    description: "Assemble, render, and deliver your finished vertical video.",
  },
];

function normalizeStepStatus(status?: string): PipelineStepStatus {
  if (status === "completed" || status === "failed" || status === "active")
    return status;
  return "pending";
}

function getStepStatusFromPipeline(
  currentNode: string,
  completedNodes: string[],
  stepId: PipelineStepId,
): PipelineStepStatus {
  if (completedNodes.includes(stepId)) return "completed";
  if (currentNode === stepId) return "active";
  return "pending";
}

export default function DashboardPage() {
  const [topic, setTopic] = useState("Jawahar lal Nehru leadership");
  const [language, setLanguage] = useState<"english" | "hindi">("english");
  const [limit, setLimit] = useState(10);
  const [duration, setDuration] = useState(30);
  const [isRunning, setIsRunning] = useState(false);
  const [result, setResult] = useState<PipelineResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [apiStatus, setApiStatus] = useState<"checking" | "online" | "offline">(
    "checking",
  );
  const [stepStatuses, setStepStatuses] = useState<
    Record<PipelineStepId, PipelineStepStatus>
  >({
    fetch_trends: "pending",
    animate_assets: "pending",
    assemble_video: "pending",
  });
  const [toast, setToast] = useState<{
    message: string;
    type: "success" | "error" | "warning";
  } | null>(null);
  const [pollingRunId, setPollingRunId] = useState<string | null>(null);
  const [showImageSelector, setShowImageSelector] = useState(false);
  const [currentSelectionBlock, setCurrentSelectionBlock] = useState<{
    blockIndex: number;
    narrationText: string;
    candidates: ImageCandidate[];
  } | null>(null);
  const [processedBlockIndices, setProcessedBlockIndices] = useState<
    Set<number>
  >(new Set());
  const [customImagePreview, setCustomImagePreview] = useState<string | null>(null);
  const [customImageFile, setCustomImageFile] = useState<File | null>(null);
  const [uploadingCustom, setUploadingCustom] = useState(false);
  const pollingIntervalRef = useRef<NodeJS.Timeout | null>(null);

  const imageCount = Math.ceil(duration / 5);

  useEffect(() => {
    let mounted = true;
    api
      .health()
      .then(() => {
        if (mounted) setApiStatus("online");
      })
      .catch(() => {
        if (mounted) setApiStatus("offline");
      });
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timeout = window.setTimeout(() => setToast(null), 4500);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  const showToast = (
    message: string,
    type: "success" | "error" | "warning" = "success",
  ) => {
    setToast({ message, type });
  };

  const stopPolling = useCallback(() => {
    if (pollingIntervalRef.current) {
      clearInterval(pollingIntervalRef.current);
      pollingIntervalRef.current = null;
    }
  }, []);

  const startPolling = useCallback(
    (runId: string) => {
      setPollingRunId(runId);

      const poll = async () => {
        try {
          const response = await api.pipelineStatus(runId);
          if (!response.success || !response.data) {
            console.error("Pipeline status error:", response.error);
            return;
          }

          const data = response.data as PipelineStatusData;
          if (data.thread_id) setPollingRunId(data.thread_id);

          // Update step statuses based on current node and completed nodes
          setStepStatuses({
            fetch_trends: getStepStatusFromPipeline(
              data.current_node,
              data.completed_nodes,
              "fetch_trends",
            ),
            animate_assets: getStepStatusFromPipeline(
              data.current_node,
              data.completed_nodes,
              "animate_assets",
            ),
            assemble_video: getStepStatusFromPipeline(
              data.current_node,
              data.completed_nodes,
              "assemble_video",
            ),
          });

          // Check for human-in-the-loop - image selection (new)
          if (data.awaiting_image_selection) {
            const blockIndex = data.awaiting_image_selection.block_index;
            // Ignore if this block was already processed (stale interrupt)
            // Also ignore if modal is already open for this same block (prevents flicker)
            const alreadyProcessed = processedBlockIndices.has(blockIndex);
            const modalOpenForSameBlock = showImageSelector && currentSelectionBlock?.blockIndex === blockIndex;
            
            if (alreadyProcessed || modalOpenForSameBlock) {
              console.log(`Ignoring stale interrupt for block ${blockIndex} (processed: ${alreadyProcessed}, modalOpen: ${modalOpenForSameBlock})`);
              return;
            }
            stopPolling();
            showToast(
              `Select image for: "${data.awaiting_image_selection.narration_text.slice(0, 50)}..."`,
              "warning",
            );
            setCurrentSelectionBlock({
              blockIndex: data.awaiting_image_selection.block_index,
              narrationText: data.awaiting_image_selection.narration_text,
              candidates: data.awaiting_image_selection.candidates,
            });
            setShowImageSelector(true);
            return;
          }

          // Check for human-in-the-loop - legacy image upload
          if (data.awaiting_human_image) {
            showToast(
              `Waiting for human image for: "${data.awaiting_human_image.narration_text.slice(0, 50)}..."`,
              "warning",
            );
          }

          // Pipeline completed or failed
          if (data.status === "completed" || data.status === "failed") {
            stopPolling();
            setPollingRunId(null);

            if (data.status === "completed" && data.video_url) {
              setResult({
                status: "completed",
                render_id: data.render_id || "",
                video_url: data.video_url,
                run_id: data.run_id,
                provider: "shotstack",
                steps: {
                  fetch_trends: { status: "completed" },
                  animate_assets: { status: "completed" },
                  assemble_video: { status: "completed" },
                },
              });
              showToast("Your video is ready to review.", "success");
            } else if (data.status === "failed") {
              setError(data.error || "Pipeline failed");
              showToast(data.error || "Pipeline failed", "error");
            }
            setIsRunning(false);
          }
        } catch (err) {
          console.error("Polling error:", err);
        }
      };

      // Initial poll immediately
      poll();

      // Then poll every 2 seconds
      pollingIntervalRef.current = setInterval(poll, 2000);
    },
    [showToast, stopPolling],
  );

  async function runPipeline() {
    if (!topic.trim()) {
      showToast("Please enter a topic", "error");
      return;
    }

    setIsRunning(true);
    setError(null);
    setResult(null);
    stopPolling();
    setPollingRunId(null);
    setShowImageSelector(false);
    setCurrentSelectionBlock(null);
    setProcessedBlockIndices(new Set());
    setStepStatuses({
      fetch_trends: "active",
      animate_assets: "pending",
      assemble_video: "pending",
    });

    // Reset custom image state
    setCustomImagePreview(null);
    setCustomImageFile(null);

    try {
      // Start the pipeline (now synchronous - waits for completion or HITL pause)
      const response = await api.runPipeline(
        topic.trim(),
        limit,
        language,
        duration,
      );
      console.log("Pipeline response:", response);
      if (!response.success || !response.data) {
        throw new Error(response.error || "Failed to start pipeline");
      }

      const data = response.data;
      const threadId = data.thread_id;
      if (threadId) setPollingRunId(threadId);

      // If pipeline completed fully
      if (data.status === "completed" && data.video_url) {
        setResult({
          status: "completed",
          render_id: data.render_id || "",
          video_url: data.video_url,
          run_id: data.run_id || "",
          provider: data.provider || "shotstack",
          steps: {
            fetch_trends: { status: "completed" },
            animate_assets: { status: "completed" },
            assemble_video: { status: "completed" },
          },
        });
        setStepStatuses({
          fetch_trends: "completed",
          animate_assets: "completed",
          assemble_video: "completed",
        });
        showToast("Your video is ready to review.", "success");
        setIsRunning(false);
        return;
      }

      // Show the first image-selection interrupt immediately.
      if (
        data.status === "awaiting_image_selection" &&
        data.interrupt &&
        threadId
      ) {
        setCurrentSelectionBlock({
          blockIndex: data.interrupt.block_index,
          narrationText: data.interrupt.narration_text,
          candidates: data.interrupt.candidates,
        });
        setShowImageSelector(true);
        showToast(
          `Choose an image for scene ${data.interrupt.block_index + 1}.`,
          "warning",
        );
        return;
      }

      if (
        (data.status === "awaiting_human_image" ||
          data.status === "awaiting_image_selection") &&
        threadId
      ) {
        startPolling(threadId);
        return;
      }

      // If failed
      if (data.status === "failed" || data.error) {
        throw new Error(data.error || "Pipeline failed");
      }

      // Fallback: start polling
      if (threadId) {
        startPolling(threadId);
      }
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Pipeline failed to start";
      console.error("Pipeline start error:", message, err);
      setError(message);
      setStepStatuses((current) => ({ ...current, fetch_trends: "failed" }));
      showToast(message, "error");
      setIsRunning(false);
    }
  }

  // Cleanup polling on unmount
  useEffect(() => {
    return () => stopPolling();
  }, [stopPolling]);

  useEffect(() => {
    if (!toast) return;
    const timeout = window.setTimeout(() => setToast(null), 4500);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  async function copyText(value: string, label: string) {
    try {
      await navigator.clipboard.writeText(value);
      showToast(`${label} copied`, "success");
    } catch {
      showToast(`Could not copy ${label.toLowerCase()}`, "error");
    }
  }

  const handleImageSelect = async (selectedImageUrl: string) => {
    const threadId = pollingRunId;
    if (!currentSelectionBlock || !threadId) return;

    const blockIndex = currentSelectionBlock.blockIndex;

    // Immediately mark as processed and close modal to prevent race conditions
    setProcessedBlockIndices((prev) => new Set(prev).add(blockIndex));
    setShowImageSelector(false);
    setCurrentSelectionBlock(null);

    try {
      showToast("Processing selected image...", "warning");
      const response = await api.resumePipelineSelection(
        threadId,
        blockIndex,
        selectedImageUrl,
      );
      if (!response.success) {
        throw new Error(response.error || "Failed to resume pipeline");
      }

      if (
        response.data?.status === "awaiting_image_selection" &&
        response.data.interrupt
      ) {
        const nextSelection = response.data.interrupt;
        setCurrentSelectionBlock({
          blockIndex: nextSelection.block_index,
          narrationText: nextSelection.narration_text,
          candidates: nextSelection.candidates,
        });
        setShowImageSelector(true);
        showToast(
          `Choose an image for scene ${nextSelection.block_index + 1}.`,
          "warning",
        );
        return;
      }

      // If pipeline completed
      if (response.data?.status === "completed" && response.data?.video_url) {
        setResult({
          status: "completed",
          render_id: response.data.render_id || "",
          video_url: response.data.video_url,
          run_id: response.data.run_id || "",
          provider: "shotstack",
          steps: {
            fetch_trends: { status: "completed" },
            animate_assets: { status: "completed" },
            assemble_video: { status: "completed" },
          },
        });
        setStepStatuses({
          fetch_trends: "completed",
          animate_assets: "completed",
          assemble_video: "completed",
        });
        showToast("Your video is ready to review.", "success");
        setIsRunning(false);
        setPollingRunId(null);
      } else if (response.data?.status === "failed") {
        setError(response.data.error || "Pipeline failed");
        showToast(response.data.error || "Pipeline failed", "error");
        setIsRunning(false);
        setPollingRunId(null);
      } else {
        // Resume polling for next block
        startPolling(threadId);
      }
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to process selection";
      console.error("Image selection error:", message, err);
      showToast(message, "error");
    }
  };

  const uploadCustomImage = async (file: File): Promise<string> => {
    const threadId = pollingRunId;
    const blockIndex = currentSelectionBlock?.blockIndex;
    if (!threadId || blockIndex === undefined) throw new Error("No active pipeline");

    const formData = new FormData();
    formData.append("image", file);

    const response = await fetch(
      `${process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000"}/api/human-image/${threadId}/${blockIndex}`,
      { method: "POST", body: formData }
    );

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.detail || "Upload failed");
    }

    const data = await response.json();
    return data.data.image_url;
  };

  const handleCustomImageSelect = async () => {
    if (!customImageFile || !customImagePreview) return;

    setUploadingCustom(true);
    try {
      const imageUrl = await uploadCustomImage(customImageFile);
      // Clear custom image state
      setCustomImagePreview(null);
      setCustomImageFile(null);
      // Use the uploaded URL
      await handleImageSelect(imageUrl);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Upload failed";
      showToast(message, "error");
    } finally {
      setUploadingCustom(false);
    }
  };

  const handleCustomImageChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Validate file type
    if (!file.type.startsWith("image/")) {
      showToast("Please select an image file", "error");
      return;
    }
    // Validate file size (max 10MB)
    if (file.size > 10 * 1024 * 1024) {
      showToast("Image must be less than 10MB", "error");
      return;
    }

    setCustomImageFile(file);
    setCustomImagePreview(URL.createObjectURL(file));
  };

  const removeCustomImage = () => {
    if (customImagePreview) URL.revokeObjectURL(customImagePreview);
    setCustomImagePreview(null);
    setCustomImageFile(null);
  };

  const stepCount = Object.values(stepStatuses).filter(
    (status) => status === "completed",
  ).length;

  return (
    <div className="studio-shell">
      <aside className="sidebar">
        <a className="brand" href="#studio" aria-label="Shortform Studio home">
          <span className="brand-mark">
            <Clapperboard size={18} strokeWidth={2.3} />
          </span>
          <span>
            shortform<span className="brand-period">.</span>
          </span>
        </a>

        <div className="workspace-switcher">
          <span className="workspace-avatar">S</span>
          <span className="workspace-copy">
            <strong>Studio workspace</strong>
            <small>Personal</small>
          </span>
          <span className="switcher-dots">•••</span>
        </div>

        <div className="nav-caption">WORKSPACE</div>
        <nav className="side-nav" aria-label="Workspace navigation">
          <a className="side-link active" href="#studio" aria-current="page">
            <Clapperboard size={17} />
            <span>Create video</span>
            <span className="nav-count">01</span>
          </a>
          <a className="side-link" href="#pipeline">
            <Activity size={17} />
            <span>Pipeline</span>
          </a>
        </nav>

        <div className="sidebar-note">
          <span className="note-icon">
            <Sparkles size={15} />
          </span>
          <p>Your next story is one topic away.</p>
        </div>

        <div className="sidebar-footer">
          <span className={`connection-indicator ${apiStatus}`} />
          <span>
            {apiStatus === "online"
              ? "Backend connected"
              : apiStatus === "offline"
                ? "Backend unavailable"
                : "Checking backend"}
          </span>
          <button
            className="icon-button sidebar-settings"
            type="button"
            title="Settings"
            aria-label="Settings"
          >
            <Settings2 size={17} />
          </button>
        </div>
      </aside>

      <div className="studio-main">
        <header className="topbar">
          <div className="breadcrumbs">
            <span>Workspace</span>
            <span className="breadcrumb-separator">/</span>
            <strong>New video</strong>
          </div>
          <div className="topbar-actions">
            <span className={`api-pill ${apiStatus}`}>
              <span className="connection-indicator" />
              {apiStatus === "online"
                ? "API online"
                : apiStatus === "offline"
                  ? "API offline"
                  : "Connecting"}
            </span>
            <button
              className="icon-button profile-button"
              type="button"
              aria-label="Profile settings"
            >
              S
            </button>
          </div>
        </header>

        <main className="studio-content">
          <section className="intro-row" id="studio">
            <div className="intro-copy">
              <div className="eyebrow">
                <span className="eyebrow-index">01</span> THE SHORTFORM STUDIO
              </div>
              <h1>
                Make something
                <br />
                <span>people stop for.</span>
              </h1>
              <p>
                Turn a good idea into a short worth watching. Start with a
                topic; we'll take it from script to screen.
              </p>
            </div>
            <div
              className="format-stamp"
              aria-label="Vertical video format, nine by sixteen"
            >
              <span className="format-stamp-label">BUILT FOR</span>
              <span className="format-ratio">9:16</span>
              <span className="format-stamp-foot">
                <Film size={13} /> VERTICAL VIDEO
              </span>
            </div>
          </section>

          <section className="create-workspace" aria-labelledby="create-title">
            <div className="create-form-panel">
              <div className="panel-heading">
                <div>
                  <span className="section-kicker">
                    NEW PROJECT <span>—</span> 01
                  </span>
                  <h2 id="create-title">Start with a topic</h2>
                </div>
                <span className="draft-tag">DRAFT</span>
              </div>

              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void runPipeline();
                }}
              >
                <label className="field-label" htmlFor="video-topic">
                  WHAT'S THE VIDEO ABOUT?
                </label>
                <div className="topic-field">
                  <Sparkles size={19} aria-hidden="true" />
                  <input
                    id="video-topic"
                    type="text"
                    value={topic}
                    onChange={(event) => setTopic(event.target.value)}
                    placeholder="Try: the hidden history of street food"
                    disabled={isRunning}
                    maxLength={180}
                    required
                  />
                  <span className="topic-counter">{topic.length}/180</span>
                </div>

                <div className="settings-row">
                  <fieldset className="language-fieldset">
                    <legend className="field-label">NARRATION LANGUAGE</legend>
                    <div
                      className="language-switch"
                      role="group"
                      aria-label="Narration language"
                    >
                      <button
                        type="button"
                        className={
                          language === "english"
                            ? "language-option selected"
                            : "language-option"
                        }
                        onClick={() => setLanguage("english")}
                        disabled={isRunning}
                        aria-pressed={language === "english"}
                      >
                        English
                      </button>
                      <button
                        type="button"
                        className={
                          language === "hindi"
                            ? "language-option selected"
                            : "language-option"
                        }
                        onClick={() => setLanguage("hindi")}
                        disabled={isRunning}
                        aria-pressed={language === "hindi"}
                      >
                        Hindi
                      </button>
                    </div>
                  </fieldset>
                  <div className="limit-field">
                    <label className="field-label" htmlFor="trend-limit">
                      TREND SOURCES
                    </label>
                    <div className="number-field">
                      <input
                        id="trend-limit"
                        type="number"
                        value={limit}
                        onChange={(event) =>
                          setLimit(
                            Math.min(
                              20,
                              Math.max(1, Number(event.target.value) || 1),
                            ),
                          )
                        }
                        min={1}
                        max={20}
                        disabled={isRunning}
                      />
                      <span>sources</span>
                    </div>
                  </div>
                  <div className="duration-field">
                    <label className="field-label" htmlFor="video-duration">
                      VIDEO DURATION (MAX 30s)
                    </label>
                    <div className="number-field">
                      <input
                        id="video-duration"
                        type="number"
                        value={duration}
                        onChange={(event) =>
                          setDuration(
                            Math.min(
                              30,
                              Math.max(1, Number(event.target.value) || 1),
                            ),
                          )
                        }
                        min={1}
                        max={30}
                        disabled={isRunning}
                      />
                      <span>seconds</span>
                    </div>
                  </div>
                  <div className="image-count-field">
                    <label className="field-label">IMAGES (AUTO)</label>
                    <div className="number-field">
                      <span className="auto-value">{imageCount}</span>
                      <span>images</span>
                    </div>
                  </div>
                </div>

                <div className="form-divider" />
                <div className="form-submit-row">
                  <div className="form-footnote">
                    <span className="privacy-dot" /> Your idea stays yours. Make
                    something original.
                  </div>
                  <button
                    className="generate-button"
                    type="submit"
                    disabled={isRunning || !topic.trim()}
                  >
                    {isRunning ? (
                      <LoaderCircle size={18} className="spinning" />
                    ) : (
                      <Play size={17} fill="currentColor" />
                    )}
                    <span>
                      {isRunning ? "Creating your short" : "Generate video"}
                    </span>
                    {!isRunning && (
                      <ArrowUpRight size={17} className="generate-arrow" />
                    )}
                  </button>
                </div>
              </form>

              {error && (
                <div className="error-banner" role="alert">
                  <CircleAlert size={18} />
                  <div>
                    <strong>We couldn't finish that run.</strong>
                    <span>{error}</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => setError(null)}
                    aria-label="Dismiss error"
                  >
                    <X size={16} />
                  </button>
                </div>
              )}
            </div>

            <figure className={`frame-preview ${isRunning ? "rendering" : ""}`}>
              <img
                className="preview-image"
                src="https://images.unsplash.com/photo-1485846234645-a62644f84728?auto=format&fit=crop&w=1100&q=85"
                alt="A cinematic projection room with a lit screen"
              />
              <div className="preview-grain" />
              <div className="preview-topline">
                <span>
                  <span className="live-dot" />{" "}
                  {isRunning
                    ? "IN THE CUT"
                    : result
                      ? "YOUR LATEST CUT"
                      : "CREATIVE PREVIEW"}
                </span>
                <span className="preview-timecode">00:00:00:00</span>
              </div>
              <div className="preview-center-mark">
                <span className="preview-play">
                  <Play size={19} fill="currentColor" />
                </span>
              </div>
              <figcaption className="preview-caption">
                <div className="preview-topic-label">
                  {result
                    ? "READY FOR REVIEW"
                    : isRunning
                      ? "GOOD THINGS TAKE A BEAT"
                      : "YOUR STORY STARTS HERE"}
                </div>
                <div className="preview-topic">
                  {topic.trim() || "Your next big idea"}
                </div>
                <div className="preview-caption-bottom">
                  <span>
                    {language === "english"
                      ? "ENGLISH NARRATION"
                      : "HINDI NARRATION"}
                  </span>
                  <span>
                    9:16 <span className="preview-divider">/</span> SHORT
                  </span>
                </div>
              </figcaption>
              <div className="preview-frame-label">
                <span>FRAME 01</span>
                <span>1080 × 1920</span>
              </div>
            </figure>
          </section>

          <section
            className="pipeline-section"
            id="pipeline"
            aria-labelledby="pipeline-title"
          >
            <div className="pipeline-heading">
              <div>
                <span className="section-kicker">BEHIND THE SCENES</span>
                <h2 id="pipeline-title">The making of it</h2>
              </div>
              <div
                className={`pipeline-state ${isRunning ? "working" : result ? "finished" : "idle"}`}
              >
                <span className="pipeline-state-dot" />
                {isRunning
                  ? "IN PROGRESS"
                  : result
                    ? "COMPLETE"
                    : "READY WHEN YOU ARE"}
              </div>
            </div>

            <div
              className="pipeline-track"
              aria-label={`${stepCount} of 3 steps completed`}
            >
              <div
                className="pipeline-track-fill"
                style={{
                  width: `${(stepCount / pipelineSteps.length) * 100}%`,
                }}
              />
            </div>
            <div className="pipeline-steps">
              {pipelineSteps.map((step, index) => {
                const state = stepStatuses[step.id];
                return (
                  <div className={`pipeline-step ${state}`} key={step.id}>
                    <div className="pipeline-step-mark">
                      {state === "completed" ? (
                        <Check size={17} />
                      ) : state === "active" ? (
                        <LoaderCircle size={17} className="spinning" />
                      ) : state === "failed" ? (
                        <X size={17} />
                      ) : (
                        <Circle size={17} />
                      )}
                    </div>
                    <div className="pipeline-step-copy">
                      <span className="pipeline-step-index">
                        STEP 0{index + 1}
                      </span>
                      <h3>{step.title}</h3>
                      <p>{step.description}</p>
                    </div>
                    <span className="pipeline-step-status">
                      {state === "pending" ? "UP NEXT" : state.toUpperCase()}
                    </span>
                  </div>
                );
              })}
            </div>
            <p className="pipeline-note">
              <Clock3 size={14} /> The full run can take a few minutes. Keep
              this tab open while your short is being made.
            </p>
          </section>

          {result && (
            <section className="output-section" aria-labelledby="output-title">
              <div className="output-heading">
                <div>
                  <span className="section-kicker">FRESH OFF THE TIMELINE</span>
                  <h2 id="output-title">Your finished short</h2>
                </div>
                <span className="provider-tag">
                  <span className="provider-dot" />
                  {result.provider || "VIDEO"}
                </span>
              </div>
              {result.video_url ? (
                <div className="output-layout">
                  <div className="output-player-wrap">
                    <video
                      src={result.video_url}
                      controls
                      playsInline
                      className="output-player"
                      aria-label={`Generated video for ${topic}`}
                    />
                  </div>
                  <div className="output-details">
                    <span className="output-overline">READY TO WATCH</span>
                    <h3>{topic}</h3>
                    <p>
                      Your short has finished rendering. Give it a watch, then
                      save or share it wherever your audience is.
                    </p>
                    <div className="output-id">
                      <span>RENDER ID</span>
                      <code>{result.render_id || result.run_id || "—"}</code>
                    </div>
                    <div className="output-actions">
                      <a
                        href={result.video_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="output-button primary"
                      >
                        <ArrowUpRight size={16} /> Open video
                      </a>
                      <a
                        href={result.video_url}
                        download
                        className="output-button secondary"
                      >
                        <ArrowDownToLine size={16} /> Download
                      </a>
                      <button
                        className="output-button secondary"
                        type="button"
                        onClick={() =>
                          void copyText(result.video_url!, "Video link")
                        }
                      >
                        <Copy size={15} /> Copy link
                      </button>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="output-unavailable">
                  <CircleAlert size={18} />
                  <span>
                    The pipeline completed, but the backend did not return a
                    video URL.
                  </span>
                </div>
              )}
            </section>
          )}

          <footer className="studio-footer">
            <span>
              SHORTFORM STUDIO <span>©</span> 2025
            </span>
            <span>
              MADE FOR THE NEXT SCROLL <Sparkles size={13} />
            </span>
          </footer>
        </main>
      </div>

      {toast && (
        <div className={`toast ${toast.type}`} role="status">
          <span className="toast-icon">
            {toast.type === "success" ? (
              <Check size={16} />
            ) : toast.type === "error" ? (
              <CircleAlert size={16} />
            ) : (
              <Activity size={16} />
            )}
          </span>
          <span>{toast.message}</span>
          <button
            type="button"
            onClick={() => setToast(null)}
            aria-label="Dismiss notification"
          >
            <X size={16} />
          </button>
        </div>
      )}

      {showImageSelector && currentSelectionBlock && (
        <div className="modal-overlay" onClick={() => {}} style={{
          position: 'fixed',
          inset: 0,
          background: 'rgba(0,0,0,0.7)',
          zIndex: 100,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '1rem',
        }}>
          <div
            className="image-selector-modal"
            onClick={(e) => e.stopPropagation()}
            style={{
              background: '#fff',
              borderRadius: '12px',
              maxWidth: '95vw',
              width: '100%',
              maxHeight: '85vh',
              overflow: 'hidden',
              display: 'flex',
              flexDirection: 'column',
              boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
            }}
          >
            <div className="modal-header" style={{
              padding: '1rem 1.5rem',
              borderBottom: '1px solid #e5e7eb',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
                <h3 style={{ margin: 0, fontSize: '1.1rem', fontWeight: 600 }}>
                  Select Image for Scene {currentSelectionBlock.blockIndex + 1}
                </h3>
                <span style={{
                  fontSize: '0.75rem',
                  color: '#9ca3af',
                  background: '#f3f4f6',
                  padding: '0.25rem 0.75rem',
                  borderRadius: '999px',
                }}>
                  Scene {currentSelectionBlock.blockIndex + 1} of {Math.ceil(duration / 5)}
                </span>
              </div>
              <div style={{
                background: '#f0f4f8',
                border: '1px solid #d1d9e0',
                borderRadius: '8px',
                padding: '1rem',
                marginTop: '0.5rem',
              }}>
                <span style={{
                  fontSize: '0.75rem',
                  fontWeight: 600,
                  color: '#374151',
                  textTransform: 'uppercase',
                  letterSpacing: '0.05em',
                  marginBottom: '0.375rem',
                  display: 'block',
                }}>
                  Narration for this scene
                </span>
                <p style={{
                  margin: 0,
                  fontSize: '0.9375rem',
                  color: '#1f2937',
                  lineHeight: 1.5,
                }}>
                  {currentSelectionBlock.narrationText}
                </p>
              </div>
            </div>
            <div className="candidates-grid" style={{
              display: 'flex',
              flexDirection: 'row',
              gap: '0.75rem',
              padding: '1rem',
              overflowX: 'auto',
              flexWrap: 'nowrap',
            }}>
              {/* Custom Image Upload Card */}
              <button
                type="button"
                onClick={() => document.getElementById('custom-image-upload')?.click()}
                disabled={uploadingCustom}
                style={{
                  flex: '0 0 180px',
                  width: '180px',
                  height: '220px',
                  background: uploadingCustom ? '#f9fafb' : '#fafbfc',
                  border: '2px dashed #cbd5e1',
                  borderRadius: '8px',
                  cursor: uploadingCustom ? 'not-allowed' : 'pointer',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '0.75rem',
                  padding: '1rem',
                  transition: 'border-color 0.2s, background 0.2s',
                }}
                onMouseEnter={(e) => {
                  if (!uploadingCustom) {
                    e.currentTarget.style.borderColor = '#6366f1';
                    e.currentTarget.style.background = '#f0f4f8';
                  }
                }}
                onMouseLeave={(e) => {
                  if (!uploadingCustom) {
                    e.currentTarget.style.borderColor = '#cbd5e1';
                    e.currentTarget.style.background = '#fafbfc';
                  }
                }}
              >
                <input
                  id="custom-image-upload"
                  type="file"
                  accept="image/*"
                  style={{ display: 'none' }}
                  onChange={handleCustomImageChange}
                  disabled={uploadingCustom}
                />
                {customImagePreview ? (
                  <>
                    <div style={{
                      position: 'relative',
                      width: '100%',
                      height: '140px',
                      background: '#f3f4f6',
                      borderRadius: '6px',
                      overflow: 'hidden',
                      flexShrink: 0,
                    }}>
                      <img
                        src={customImagePreview}
                        alt="Custom upload preview"
                        style={{
                          width: '100%',
                          height: '100%',
                          objectFit: 'cover',
                        }}
                      />
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); removeCustomImage(); }}
                        style={{
                          position: 'absolute',
                          top: '0.5rem',
                          right: '0.5rem',
                          width: '24px',
                          height: '24px',
                          borderRadius: '50%',
                          background: 'rgba(0,0,0,0.6)',
                          color: '#fff',
                          border: 'none',
                          cursor: 'pointer',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                        }}
                        aria-label="Remove custom image"
                      >
                        <X size={14} />
                      </button>
                    </div>
                    <div style={{
                      width: '100%',
                      textAlign: 'center',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '0.375rem',
                    }}>
                      <span style={{
                        fontSize: '0.8125rem',
                        fontWeight: 500,
                        color: '#1f2937',
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      }}>
                        {customImageFile?.name || 'Custom image'}
                      </span>
                      <span style={{
                        fontSize: '0.6875rem',
                        color: '#9ca3af',
                      }}>
                        {(customImageFile?.size || 0) < 1024 * 1024
                          ? `${Math.round((customImageFile?.size || 0) / 1024)} KB`
                          : `${((customImageFile?.size || 0) / (1024 * 1024)).toFixed(1)} MB`}
                      </span>
                      {uploadingCustom ? (
                        <span style={{
                          fontSize: '0.6875rem',
                          color: '#6366f1',
                        }}>
                          Uploading...
                        </span>
                      ) : (
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); handleCustomImageSelect(); }}
                          disabled={!customImageFile || uploadingCustom}
                          style={{
                            padding: '0.375rem 1rem',
                            fontSize: '0.75rem',
                            fontWeight: 600,
                            color: '#fff',
                            background: '#6366f1',
                            border: 'none',
                            borderRadius: '6px',
                            cursor: customImageFile && !uploadingCustom ? 'pointer' : 'not-allowed',
                            opacity: customImageFile && !uploadingCustom ? 1 : 0.6,
                          }}
                        >
                          Use This Image
                        </button>
                      )}
                    </div>
                  </>
                ) : (
                  <>
                    <Upload size={32} color="#9ca3af" />
                    <div style={{ textAlign: 'center', color: '#6b7280' }}>
                      <span style={{ fontSize: '0.875rem', fontWeight: 500, display: 'block' }}>
                        Upload Custom Image
                      </span>
                      <span style={{ fontSize: '0.75rem' }}>JPG, PNG, WebP • Max 10MB</span>
                    </div>
                  </>
                )}
              </button>
              {/* Candidate Cards */}
              {currentSelectionBlock.candidates.map((candidate, idx) => (
                <button
                  key={idx}
                  className="candidate-card"
                  onClick={() => handleImageSelect(candidate.url)}
                  type="button"
                  style={{
                    flex: '0 0 180px',
                    width: '180px',
                    height: '220px',
                    background: '#fff',
                    border: '2px solid #e5e7eb',
                    borderRadius: '8px',
                    cursor: 'pointer',
                    display: 'flex',
                    flexDirection: 'column',
                    overflow: 'hidden',
                    transition: 'border-color 0.2s, box-shadow 0.2s, transform 0.1s',
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.borderColor = '#6366f1';
                    e.currentTarget.style.boxShadow = '0 4px 12px rgba(99,102,241,0.15)';
                    e.currentTarget.style.transform = 'translateY(-2px)';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.borderColor = '#e5e7eb';
                    e.currentTarget.style.boxShadow = 'none';
                    e.currentTarget.style.transform = 'none';
                  }}
                >
                  <div className="candidate-image-wrapper" style={{
                    position: 'relative',
                    width: '100%',
                    height: '140px',
                    background: '#f3f4f6',
                    flexShrink: 0,
                    overflow: 'hidden',
                  }}>
                    <img
                      src={candidate.url}
                      alt={candidate.title}
                      className="candidate-image"
                      loading="lazy"
                      style={{
                        width: '100%',
                        height: '100%',
                        objectFit: 'cover',
                        transition: 'transform 0.2s',
                      }}
                    />
                    <div className="candidate-overlay" style={{
                      position: 'absolute',
                      inset: 0,
                      background: 'rgba(99,102,241,0.85)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      opacity: 0,
                      transition: 'opacity 0.2s',
                    }}>
                      <span className="select-label" style={{
                        color: '#fff',
                        fontWeight: 600,
                        fontSize: '0.875rem',
                        padding: '0.5rem 1rem',
                        background: 'rgba(0,0,0,0.3)',
                        borderRadius: '999px',
                      }}>
                        Select
                      </span>
                    </div>
                  </div>
                  <div className="candidate-info" style={{
                    padding: '0.625rem',
                    flex: '1 1 auto',
                    minHeight: '70px',
                    display: 'flex',
                    flexDirection: 'column',
                    justifyContent: 'space-between',
                    overflow: 'hidden',
                  }}>
                    <div className="candidate-title" style={{
                      fontSize: '0.8125rem',
                      fontWeight: 500,
                      color: '#1f2937',
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    }}>
                      {candidate.title || "Untitled"}
                    </div>
                    <div className="candidate-meta" style={{
                      display: 'flex',
                      flexWrap: 'wrap',
                      gap: '0.375rem',
                      marginTop: '0.25rem',
                    }}>
                      <span style={{
                        fontSize: '0.6875rem',
                        color: '#9ca3af',
                        fontFamily: 'monospace',
                      }}>
                        {candidate.width}×{candidate.height}
                      </span>
                      {candidate.category && <span style={{
                        fontSize: '0.6875rem',
                        color: '#9ca3af',
                        textTransform: 'capitalize',
                      }}>
                        {candidate.category}
                      </span>}
                    </div>
                  </div>
                </button>
              ))}
            </div>
            <div className="modal-footer" style={{
              padding: '0.75rem 1.5rem',
              borderTop: '1px solid #e5e7eb',
              textAlign: 'center',
            }}>
              <span style={{
                fontSize: '0.8125rem',
                color: '#6b7280',
              }}>
                Select an image to continue to the next scene.
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
