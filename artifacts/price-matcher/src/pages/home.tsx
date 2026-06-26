import { useState, useRef, useCallback, useEffect } from "react";
import { Dropzone } from "@/components/ui/dropzone";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Loader2, Download, AlertCircle, FileSpreadsheet, Pencil, Check, X, ChevronDown } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useDownloadMatchResult } from "@workspace/api-client-react";
import type { MatchResult } from "@workspace/api-client-react";

interface RichMatchedItem {
  name: string;
  article?: string | null;
  extractedCodes?: string[];
  quantity: number;
  unit: string | null;
  unitPrice: number | null;
  totalPrice: number | null;
  found: boolean;
  matchMethod?: "article" | "embedded_code" | "name" | "none";
  matchedName: string | null;
  matchedArticle?: string | null;
  priceSource?: 1 | 2 | null;
  alternatives?: PriceCandidate[];
}

interface RichMatchResult extends MatchResult {
  sessionId?: string;
  items: RichMatchedItem[];
}

interface PriceCandidate {
  name: string;
  price: number;
  unit?: string | null;
  article?: string | null;
}

interface Override {
  unitPrice: number | null;
  matchedName: string | null;
  matchedArticle: string | null;
  found: boolean;
}

interface ProgressState {
  processed: number;
  total: number;
  batchIndex: number;
  totalBatches: number;
  message: string;
}

interface PriceFilePreview {
  columns: string[];
  samples: Record<string, string[]>;
  detected: {
    nameColumn: string | null;
    priceColumn: string | null;
    articleColumn: string | null;
  };
}

interface OrderFilePreview {
  columns: string[];
  samples: Record<string, string[]>;
  detected: {
    nameColumn: string | null;
    qtyColumn: string | null;
    articleColumn: string | null;
  };
}

async function* readSSEEvents(response: Response): AsyncGenerator<{ event: string; data: unknown }> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let currentEvent = "message";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.startsWith("event:")) {
        currentEvent = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        const raw = line.slice(5).trim();
        try { yield { event: currentEvent, data: JSON.parse(raw) }; } catch { /* skip */ }
        currentEvent = "message";
      }
    }
  }
}

function useDebounce<T extends (...args: Parameters<T>) => void>(fn: T, delay: number) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  return useCallback((...args: Parameters<T>) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => fn(...args), delay);
  }, [fn, delay]);
}

const NONE_VALUE = "__none__";

export default function Home() {
  const { toast } = useToast();
  const [priceFile, setPriceFile] = useState<File | null>(null);
  const [orderFile, setOrderFile] = useState<File | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState<ProgressState | null>(null);
  const [result, setResult] = useState<RichMatchResult | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fromCache, setFromCache] = useState(false);

  // Cache prompt state
  const [pendingCachedResult, setPendingCachedResult] = useState<RichMatchResult | null>(null);
  const skipCacheRef = useRef(false);

  // Resizable columns
  const DEFAULT_COL_WIDTHS = [220, 130, 210, 110, 70, 55, 125, 115, 115];
  const [colWidths, setColWidths] = useState<number[]>(DEFAULT_COL_WIDTHS);
  const resizingRef = useRef<{ colIdx: number; startX: number; startWidth: number } | null>(null);

  const onResizeStart = useCallback((colIdx: number, e: React.MouseEvent) => {
    e.preventDefault();
    const startWidth = colWidths[colIdx] ?? DEFAULT_COL_WIDTHS[colIdx] ?? 100;
    resizingRef.current = { colIdx, startX: e.clientX, startWidth };

    const onMove = (ev: MouseEvent) => {
      const resizing = resizingRef.current;
      if (!resizing) return;
      const diff = ev.clientX - resizing.startX;
      const newWidth = Math.max(50, resizing.startWidth + diff);
      setColWidths((prev) => {
        const next = [...prev];
        next[resizing.colIdx] = newWidth;
        return next;
      });
    };

    const onUp = () => {
      resizingRef.current = null;
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, [colWidths]);

  // Second price file
  const [showPriceFile2, setShowPriceFile2] = useState(false);
  const [priceFile2, setPriceFile2] = useState<File | null>(null);
  const [pricePreview2, setPricePreview2] = useState<PriceFilePreview | null>(null);
  const [isPreviewLoading2, setIsPreviewLoading2] = useState(false);
  const [selectedNameCol2, setSelectedNameCol2] = useState<string>("");
  const [selectedPriceCol2, setSelectedPriceCol2] = useState<string>("");
  const [selectedArticleCol2, setSelectedArticleCol2] = useState<string>(NONE_VALUE);
  const [showColumnConfig2, setShowColumnConfig2] = useState(false);

  // Column selection state — price file
  const [pricePreview, setPricePreview] = useState<PriceFilePreview | null>(null);
  const [isPreviewLoading, setIsPreviewLoading] = useState(false);
  const [selectedNameCol, setSelectedNameCol] = useState<string>("");
  const [selectedPriceCol, setSelectedPriceCol] = useState<string>("");
  const [selectedArticleCol, setSelectedArticleCol] = useState<string>(NONE_VALUE);
  const [showColumnConfig, setShowColumnConfig] = useState(false);

  // Column selection state — order file
  const [orderPreview, setOrderPreview] = useState<OrderFilePreview | null>(null);
  const [isOrderPreviewLoading, setIsOrderPreviewLoading] = useState(false);
  const [selectedOrderNameCol, setSelectedOrderNameCol] = useState<string>("");
  const [selectedOrderQtyCol, setSelectedOrderQtyCol] = useState<string>("");
  const [selectedOrderArticleCol, setSelectedOrderArticleCol] = useState<string>(NONE_VALUE);
  const [showOrderColumnConfig, setShowOrderColumnConfig] = useState(false);

  // Per-row overrides: index → override
  const [overrides, setOverrides] = useState<Map<number, Override>>(new Map());
  const [articleInputs, setArticleInputs] = useState<Map<number, string>>(new Map());
  const [searchResults, setSearchResults] = useState<Map<number, PriceCandidate[]>>(new Map());
  const [searchLoading, setSearchLoading] = useState<Map<number, boolean>>(new Map());
  const [editingPrice, setEditingPrice] = useState<Map<number, string>>(new Map());

  const downloadMutation = useDownloadMatchResult();

  // Load column preview when price file changes
  const loadPricePreview = useCallback(async (file: File) => {
    setIsPreviewLoading(true);
    setPricePreview(null);
    try {
      const fd = new FormData();
      fd.append("priceFile", file);
      const res = await fetch("/api/match/preview-price", { method: "POST", body: fd });
      if (!res.ok) throw new Error("preview failed");
      const preview = await res.json() as PriceFilePreview;
      setPricePreview(preview);
      setSelectedNameCol(preview.detected.nameColumn ?? preview.columns[0] ?? "");
      setSelectedPriceCol(preview.detected.priceColumn ?? "");
      setSelectedArticleCol(preview.detected.articleColumn ?? NONE_VALUE);
    } catch {
      setPricePreview(null);
    } finally {
      setIsPreviewLoading(false);
    }
  }, []);

  const loadPricePreview2 = useCallback(async (file: File) => {
    setIsPreviewLoading2(true);
    setPricePreview2(null);
    try {
      const fd = new FormData();
      fd.append("priceFile", file);
      const res = await fetch("/api/match/preview-price", { method: "POST", body: fd });
      if (!res.ok) throw new Error("preview failed");
      const preview = await res.json() as PriceFilePreview;
      setPricePreview2(preview);
      setSelectedNameCol2(preview.detected.nameColumn ?? preview.columns[0] ?? "");
      setSelectedPriceCol2(preview.detected.priceColumn ?? "");
      setSelectedArticleCol2(preview.detected.articleColumn ?? NONE_VALUE);
    } catch {
      setPricePreview2(null);
    } finally {
      setIsPreviewLoading2(false);
    }
  }, []);

  const loadOrderPreview = useCallback(async (file: File) => {
    setIsOrderPreviewLoading(true);
    setOrderPreview(null);
    try {
      const fd = new FormData();
      fd.append("orderFile", file);
      const res = await fetch("/api/match/preview-order", { method: "POST", body: fd });
      if (!res.ok) throw new Error("preview failed");
      const preview = await res.json() as OrderFilePreview;
      setOrderPreview(preview);
      setSelectedOrderNameCol(preview.detected.nameColumn ?? preview.columns[0] ?? "");
      setSelectedOrderQtyCol(preview.detected.qtyColumn ?? "");
      setSelectedOrderArticleCol(preview.detected.articleColumn ?? NONE_VALUE);
    } catch {
      setOrderPreview(null);
    } finally {
      setIsOrderPreviewLoading(false);
    }
  }, []);

  const handlePriceFileSelect = (file: File | null) => {
    setPriceFile(file);
    setPricePreview(null);
    setShowColumnConfig(false);
    if (file) void loadPricePreview(file);
  };

  const handlePriceFile2Select = (file: File | null) => {
    setPriceFile2(file);
    setPricePreview2(null);
    setShowColumnConfig2(false);
    if (file) void loadPricePreview2(file);
  };

  const handleOrderFileSelect = (file: File | null) => {
    setOrderFile(file);
    setOrderPreview(null);
    setShowOrderColumnConfig(false);
    if (file) void loadOrderPreview(file);
  };

  // Auto-show column config when previews loaded
  useEffect(() => {
    if (pricePreview && pricePreview.columns.length > 0) setShowColumnConfig(true);
  }, [pricePreview]);

  useEffect(() => {
    if (pricePreview2 && pricePreview2.columns.length > 0) setShowColumnConfig2(true);
  }, [pricePreview2]);

  useEffect(() => {
    if (orderPreview && orderPreview.columns.length > 0) setShowOrderColumnConfig(true);
  }, [orderPreview]);

  // ── SSE upload ─────────────────────────────────────────────────────────────
  const handleProcess = async () => {
    if (!priceFile || !orderFile) {
      toast({ title: "Ошибка", description: "Пожалуйста, загрузите оба файла", variant: "destructive" });
      return;
    }
    setIsProcessing(true);
    setError(null);
    setResult(null);
    setProgress(null);
    setFromCache(false);
    setPendingCachedResult(null);
    setOverrides(new Map());
    setArticleInputs(new Map());
    setSearchResults(new Map());
    setSearchLoading(new Map());
    setEditingPrice(new Map());
    setSessionId(null);

    try {
      const formData = new FormData();
      formData.append("priceFile", priceFile);
      formData.append("orderFile", orderFile);
      if (selectedNameCol) formData.append("nameColumn", selectedNameCol);
      if (selectedPriceCol) formData.append("priceColumn", selectedPriceCol);
      if (selectedArticleCol && selectedArticleCol !== NONE_VALUE) formData.append("articleColumn", selectedArticleCol);
      if (priceFile2) {
        formData.append("priceFile2", priceFile2);
        if (selectedNameCol2) formData.append("nameColumn2", selectedNameCol2);
        if (selectedPriceCol2) formData.append("priceColumn2", selectedPriceCol2);
        if (selectedArticleCol2 && selectedArticleCol2 !== NONE_VALUE) formData.append("articleColumn2", selectedArticleCol2);
      }
      if (selectedOrderNameCol) formData.append("orderNameColumn", selectedOrderNameCol);
      if (selectedOrderQtyCol) formData.append("orderQtyColumn", selectedOrderQtyCol);
      if (selectedOrderArticleCol && selectedOrderArticleCol !== NONE_VALUE) formData.append("orderArticleColumn", selectedOrderArticleCol);
      if (skipCacheRef.current) formData.append("skipCache", "true");
      skipCacheRef.current = false;

      const res = await fetch("/api/match", { method: "POST", body: formData });
      if (!res.ok || !res.body) {
        const err = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(err.error || "Произошла ошибка при обработке файлов");
      }

      for await (const { event, data } of readSSEEvents(res)) {
        const d = data as Record<string, unknown>;
        if (event === "status") {
          setProgress({ processed: 0, total: (d.orderCount as number) || 0, batchIndex: 0, totalBatches: 0, message: (d.message as string) || "Обработка..." });
        } else if (event === "progress") {
          setProgress({ processed: (d.processed as number) || 0, total: (d.total as number) || 0, batchIndex: (d.batchIndex as number) || 0, totalBatches: (d.totalBatches as number) || 0, message: `Батч ${d.batchIndex} из ${d.totalBatches}...` });
        } else if (event === "cache_hit") {
          setProgress(null);
          setPendingCachedResult(data as RichMatchResult);
        } else if (event === "result") {
          const r = data as RichMatchResult;
          setResult(r);
          setSessionId(r.sessionId ?? null);
          setProgress(null);
          toast({ title: "Готово", description: "Файлы успешно проанализированы" });
        } else if (event === "error") {
          throw new Error((d.error as string) || "Произошла ошибка");
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Произошла ошибка");
      setProgress(null);
    } finally {
      setIsProcessing(false);
    }
  };

  const applyCachedResult = () => {
    if (!pendingCachedResult) return;
    setResult(pendingCachedResult);
    setSessionId(pendingCachedResult.sessionId ?? null);
    setFromCache(true);
    setPendingCachedResult(null);
    toast({ title: "Загружено из кэша", description: "Результат восстановлен из кэша" });
  };

  const reprocessFiles = () => {
    setPendingCachedResult(null);
    skipCacheRef.current = true;
    void handleProcess();
  };

  // ── Article search ──────────────────────────────────────────────────────────
  const doSearch = useCallback(async (idx: number, query: string) => {
    if (!sessionId || query.length < 2) {
      setSearchResults((m) => { const n = new Map(m); n.delete(idx); return n; });
      return;
    }
    setSearchLoading((m) => { const n = new Map(m); n.set(idx, true); return n; });
    try {
      const resp = await fetch(`/api/match/price-search?sessionId=${encodeURIComponent(sessionId)}&q=${encodeURIComponent(query)}`);
      const json = await resp.json() as { items: PriceCandidate[] };
      setSearchResults((m) => { const n = new Map(m); n.set(idx, json.items ?? []); return n; });
    } catch {
      setSearchResults((m) => { const n = new Map(m); n.set(idx, []); return n; });
    } finally {
      setSearchLoading((m) => { const n = new Map(m); n.set(idx, false); return n; });
    }
  }, [sessionId]);

  const debouncedSearch = useDebounce(doSearch, 400);

  const handleArticleInput = (idx: number, value: string) => {
    setArticleInputs((m) => { const n = new Map(m); n.set(idx, value); return n; });
    debouncedSearch(idx, value);
  };

  const applyCandidate = (idx: number, candidate: PriceCandidate) => {
    const item = result?.items[idx];
    if (!item) return;
    const qty = item.quantity;
    setOverrides((m) => {
      const n = new Map(m);
      n.set(idx, {
        unitPrice: candidate.price,
        matchedName: candidate.name,
        matchedArticle: candidate.article ?? null,
        found: true,
      });
      return n;
    });
    setArticleInputs((m) => { const n = new Map(m); n.delete(idx); return n; });
    setSearchResults((m) => { const n = new Map(m); n.delete(idx); return n; });
    setEditingPrice((m) => { const n = new Map(m); n.set(idx, String(candidate.price)); return n; });
    void qty;
  };

  const applyManualPrice = (idx: number, priceStr: string) => {
    const p = parseFloat(priceStr.replace(",", "."));
    if (isNaN(p)) return;
    setOverrides((m) => {
      const n = new Map(m);
      const existing = n.get(idx);
      n.set(idx, { unitPrice: p, matchedName: existing?.matchedName ?? null, matchedArticle: existing?.matchedArticle ?? null, found: true });
      return n;
    });
  };

  const clearOverride = (idx: number) => {
    setOverrides((m) => { const n = new Map(m); n.delete(idx); return n; });
    setArticleInputs((m) => { const n = new Map(m); n.delete(idx); return n; });
    setSearchResults((m) => { const n = new Map(m); n.delete(idx); return n; });
    setEditingPrice((m) => { const n = new Map(m); n.delete(idx); return n; });
  };

  // ── Computed result with overrides applied ──────────────────────────────────
  const effectiveItems = result?.items.map((item, idx) => {
    const ov = overrides.get(idx);
    if (!ov) return item;
    return { ...item, ...ov, totalPrice: ov.unitPrice != null ? ov.unitPrice * item.quantity : null };
  }) ?? [];

  const effectiveGrandTotal = effectiveItems.reduce((s, i) => s + (i.totalPrice ?? 0), 0);

  // ── Download ────────────────────────────────────────────────────────────────
  const [downloadPending, setDownloadPending] = useState(false);
  const handleDownload = async () => {
    if (!result) return;
    setDownloadPending(true);
    try {
      // If session is still cached on the server, use lightweight GET endpoint
      if (sessionId) {
        const check = await fetch(`/api/match/download-session/${encodeURIComponent(sessionId)}`, { method: "HEAD" });
        if (check.ok) {
          const a = document.createElement("a");
          a.href = `/api/match/download-session/${encodeURIComponent(sessionId)}`;
          a.download = "результат.xlsx";
          document.body.appendChild(a);
          a.click();
          a.remove();
          return;
        }
      }
      // Fallback: POST payload (works for small results)
      const payload = { ...result, items: effectiveItems, grandTotal: effectiveGrandTotal };
      const { downloadId } = await downloadMutation.mutateAsync({ data: payload as unknown as MatchResult });
      const a = document.createElement("a");
      a.href = `/api/match/download/${downloadId}`;
      a.download = "результат.xlsx";
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch {
      toast({ title: "Ошибка скачивания", description: "Не удалось скачать результат", variant: "destructive" });
    } finally {
      setDownloadPending(false);
    }
  };

  const resetState = () => {
    setPriceFile(null); setOrderFile(null); setResult(null); setError(null);
    setProgress(null); setFromCache(false); setSessionId(null);
    setOverrides(new Map()); setArticleInputs(new Map());
    setSearchResults(new Map()); setSearchLoading(new Map()); setEditingPrice(new Map());
    setPricePreview(null); setSelectedNameCol(""); setSelectedPriceCol("");
    setSelectedArticleCol(NONE_VALUE); setShowColumnConfig(false);
    setPriceFile2(null); setShowPriceFile2(false); setPricePreview2(null);
    setSelectedNameCol2(""); setSelectedPriceCol2("");
    setSelectedArticleCol2(NONE_VALUE); setShowColumnConfig2(false);
    setOrderPreview(null); setSelectedOrderNameCol(""); setSelectedOrderQtyCol("");
    setSelectedOrderArticleCol(NONE_VALUE); setShowOrderColumnConfig(false);
    setPendingCachedResult(null); skipCacheRef.current = false;
  };

  const progressPercent = progress && progress.total > 0 ? Math.round((progress.processed / progress.total) * 100) : null;

  // ── Method badge ────────────────────────────────────────────────────────────
  const methodBadge = (item: RichMatchedItem, ov?: Override) => {
    if (ov?.found) {
      return <Badge variant="outline" className="bg-violet-50 text-violet-700 border-violet-200 dark:bg-violet-950/30 dark:text-violet-400 dark:border-violet-800 font-medium text-[11px]">Вручную</Badge>;
    }
    if (!item.found) {
      return <Badge variant="outline" className="bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/30 dark:text-amber-400 dark:border-amber-800 font-medium text-[11px]">Не найден</Badge>;
    }
    const method = item.matchMethod ?? "name";
    if (method === "article") return <Badge variant="outline" className="bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/30 dark:text-emerald-400 dark:border-emerald-800 font-medium text-[11px]">По артикулу</Badge>;
    if (method === "embedded_code") return <Badge variant="outline" className="bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950/30 dark:text-blue-400 dark:border-blue-800 font-medium text-[11px]">По коду</Badge>;
    return <Badge variant="outline" className="bg-slate-50 text-slate-600 border-slate-200 dark:bg-slate-950/30 dark:text-slate-400 dark:border-slate-700 font-medium text-[11px]">По названию</Badge>;
  };

  // ── Column selector UI ──────────────────────────────────────────────────────
  const ColumnSelector = () => {
    if (!priceFile) return null;
    if (isPreviewLoading) {
      return (
        <div className="flex items-center gap-2 text-sm text-muted-foreground mt-3 px-1">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          <span>Определяем колонки прайса...</span>
        </div>
      );
    }
    if (!pricePreview || pricePreview.columns.length === 0) return null;

    const cols = pricePreview.columns;
    const samples = pricePreview.samples;

    const samplePreview = (col: string) => {
      const vals = samples[col] ?? [];
      if (!vals.length) return null;
      return <span className="text-muted-foreground/70 truncate max-w-[160px] block">{vals.slice(0, 2).join(", ")}</span>;
    };

    return (
      <div className="mt-4 rounded-lg border border-border bg-muted/30">
        <button
          type="button"
          onClick={() => setShowColumnConfig((v) => !v)}
          className="w-full flex items-center justify-between px-4 py-3 text-sm font-medium hover:bg-muted/50 transition-colors rounded-lg"
        >
          <span className="flex items-center gap-2">
            <span>Колонки прайса</span>
            {selectedNameCol && selectedPriceCol && (
              <Badge variant="outline" className="text-[11px] font-normal bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/30 dark:text-emerald-400 dark:border-emerald-800">
                {selectedNameCol} / {selectedPriceCol}
              </Badge>
            )}
          </span>
          <ChevronDown className={`h-4 w-4 text-muted-foreground transition-transform ${showColumnConfig ? "rotate-180" : ""}`} />
        </button>

        {showColumnConfig && (
          <div className="px-4 pb-4 space-y-4 border-t border-border pt-4">
            <p className="text-xs text-muted-foreground">
              Система автоматически определила колонки. Проверьте и при необходимости скорректируйте.
            </p>
            <div className="grid gap-4 sm:grid-cols-3">
              {/* Name column */}
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-foreground">Колонка с названием</label>
                <Select value={selectedNameCol} onValueChange={setSelectedNameCol}>
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue placeholder="Выберите колонку" />
                  </SelectTrigger>
                  <SelectContent className="max-h-[210px] overflow-y-auto">
                    {cols.map((col) => (
                      <SelectItem key={col} value={col} className="text-xs">
                        <span className="font-medium">{col}</span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {samplePreview(selectedNameCol)}
              </div>

              {/* Price column */}
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-foreground">Колонка с ценой</label>
                <Select value={selectedPriceCol} onValueChange={setSelectedPriceCol}>
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue placeholder="Выберите колонку" />
                  </SelectTrigger>
                  <SelectContent className="max-h-[210px] overflow-y-auto">
                    {cols.map((col) => (
                      <SelectItem key={col} value={col} className="text-xs">
                        <span className="font-medium">{col}</span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {samplePreview(selectedPriceCol)}
              </div>

              {/* Article column (optional) */}
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-foreground">Артикул <span className="text-muted-foreground font-normal">(необязательно)</span></label>
                <Select value={selectedArticleCol} onValueChange={setSelectedArticleCol}>
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue placeholder="Не выбрано" />
                  </SelectTrigger>
                  <SelectContent className="max-h-[210px] overflow-y-auto">
                    <SelectItem value={NONE_VALUE} className="text-xs text-muted-foreground">Не выбрано</SelectItem>
                    {cols.map((col) => (
                      <SelectItem key={col} value={col} className="text-xs">
                        <span className="font-medium">{col}</span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {selectedArticleCol && selectedArticleCol !== NONE_VALUE && samplePreview(selectedArticleCol)}
              </div>
            </div>
          </div>
        )}
      </div>
    );
  };

  // ── Order file column selector UI ───────────────────────────────────────────
  const OrderColumnSelector = () => {
    if (!orderFile) return null;
    if (isOrderPreviewLoading) {
      return (
        <div className="flex items-center gap-2 text-sm text-muted-foreground mt-3 px-1">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          <span>Определяем колонки списка...</span>
        </div>
      );
    }
    if (!orderPreview || orderPreview.columns.length === 0) return null;

    const cols = orderPreview.columns;
    const samples = orderPreview.samples;

    const samplePreview = (col: string) => {
      const vals = samples[col] ?? [];
      if (!vals.length) return null;
      return <span className="text-muted-foreground/70 truncate max-w-[160px] block">{vals.slice(0, 2).join(", ")}</span>;
    };

    return (
      <div className="mt-4 rounded-lg border border-border bg-muted/30">
        <button
          type="button"
          onClick={() => setShowOrderColumnConfig((v) => !v)}
          className="w-full flex items-center justify-between px-4 py-3 text-sm font-medium hover:bg-muted/50 transition-colors rounded-lg"
        >
          <span className="flex items-center gap-2">
            <span>Колонки списка товаров</span>
            {selectedOrderNameCol && selectedOrderQtyCol && (
              <Badge variant="outline" className="text-[11px] font-normal bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/30 dark:text-emerald-400 dark:border-emerald-800">
                {selectedOrderNameCol} / {selectedOrderQtyCol}
              </Badge>
            )}
          </span>
          <ChevronDown className={`h-4 w-4 text-muted-foreground transition-transform ${showOrderColumnConfig ? "rotate-180" : ""}`} />
        </button>

        {showOrderColumnConfig && (
          <div className="px-4 pb-4 space-y-4 border-t border-border pt-4">
            <p className="text-xs text-muted-foreground">
              Укажите колонки с наименованием и количеством в вашем списке товаров.
            </p>
            <div className="grid gap-4 sm:grid-cols-3">
              {/* Name column */}
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-foreground">Колонка с названием</label>
                <Select value={selectedOrderNameCol} onValueChange={setSelectedOrderNameCol}>
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue placeholder="Выберите колонку" />
                  </SelectTrigger>
                  <SelectContent className="max-h-[210px] overflow-y-auto">
                    {cols.map((col) => (
                      <SelectItem key={col} value={col} className="text-xs">
                        <span className="font-medium">{col}</span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {samplePreview(selectedOrderNameCol)}
              </div>

              {/* Qty column */}
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-foreground">Колонка с количеством</label>
                <Select value={selectedOrderQtyCol} onValueChange={setSelectedOrderQtyCol}>
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue placeholder="Выберите колонку" />
                  </SelectTrigger>
                  <SelectContent className="max-h-[210px] overflow-y-auto">
                    {cols.map((col) => (
                      <SelectItem key={col} value={col} className="text-xs">
                        <span className="font-medium">{col}</span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {samplePreview(selectedOrderQtyCol)}
              </div>

              {/* Article column (optional) */}
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-foreground">Артикул <span className="text-muted-foreground font-normal">(необязательно)</span></label>
                <Select value={selectedOrderArticleCol} onValueChange={setSelectedOrderArticleCol}>
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue placeholder="Не выбрано" />
                  </SelectTrigger>
                  <SelectContent className="max-h-[210px] overflow-y-auto">
                    <SelectItem value={NONE_VALUE} className="text-xs text-muted-foreground">Не выбрано</SelectItem>
                    {cols.map((col) => (
                      <SelectItem key={col} value={col} className="text-xs">
                        <span className="font-medium">{col}</span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {selectedOrderArticleCol && selectedOrderArticleCol !== NONE_VALUE && samplePreview(selectedOrderArticleCol)}
              </div>
            </div>
          </div>
        )}
      </div>
    );
  };

  // ── Second price column selector UI ─────────────────────────────────────────
  const ColumnSelector2 = () => {
    if (!priceFile2) return null;
    if (isPreviewLoading2) {
      return (
        <div className="flex items-center gap-2 text-sm text-muted-foreground mt-3 px-1">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          <span>Определяем колонки прайса 2...</span>
        </div>
      );
    }
    if (!pricePreview2 || pricePreview2.columns.length === 0) return null;

    const cols = pricePreview2.columns;
    const samples = pricePreview2.samples;

    const samplePreview = (col: string) => {
      const vals = samples[col] ?? [];
      if (!vals.length) return null;
      return <span className="text-muted-foreground/70 truncate max-w-[160px] block">{vals.slice(0, 2).join(", ")}</span>;
    };

    return (
      <div className="mt-2 rounded-lg border border-orange-200 bg-orange-50/30">
        <button
          type="button"
          onClick={() => setShowColumnConfig2((v) => !v)}
          className="w-full flex items-center justify-between px-4 py-3 text-sm font-medium hover:bg-orange-50/60 transition-colors rounded-lg"
        >
          <span className="flex items-center gap-2">
            <span>Колонки прайса 2</span>
            {selectedNameCol2 && selectedPriceCol2 && (
              <Badge variant="outline" className="text-[11px] font-normal bg-orange-50 text-orange-700 border-orange-200">
                {selectedNameCol2} / {selectedPriceCol2}
              </Badge>
            )}
          </span>
          <ChevronDown className={`h-4 w-4 text-muted-foreground transition-transform ${showColumnConfig2 ? "rotate-180" : ""}`} />
        </button>

        {showColumnConfig2 && (
          <div className="px-4 pb-4 space-y-4 border-t border-orange-200 pt-4">
            <p className="text-xs text-muted-foreground">
              Система автоматически определила колонки. Проверьте и при необходимости скорректируйте.
            </p>
            <div className="grid gap-4 sm:grid-cols-3">
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-foreground">Колонка с названием</label>
                <Select value={selectedNameCol2} onValueChange={setSelectedNameCol2}>
                  <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="Выберите колонку" /></SelectTrigger>
                  <SelectContent className="max-h-[210px] overflow-y-auto">
                    {cols.map((col) => <SelectItem key={col} value={col} className="text-xs"><span className="font-medium">{col}</span></SelectItem>)}
                  </SelectContent>
                </Select>
                {samplePreview(selectedNameCol2)}
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-foreground">Колонка с ценой</label>
                <Select value={selectedPriceCol2} onValueChange={setSelectedPriceCol2}>
                  <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="Выберите колонку" /></SelectTrigger>
                  <SelectContent className="max-h-[210px] overflow-y-auto">
                    {cols.map((col) => <SelectItem key={col} value={col} className="text-xs"><span className="font-medium">{col}</span></SelectItem>)}
                  </SelectContent>
                </Select>
                {samplePreview(selectedPriceCol2)}
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-foreground">Артикул <span className="text-muted-foreground font-normal">(необязательно)</span></label>
                <Select value={selectedArticleCol2} onValueChange={setSelectedArticleCol2}>
                  <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="Не выбрано" /></SelectTrigger>
                  <SelectContent className="max-h-[210px] overflow-y-auto">
                    <SelectItem value={NONE_VALUE} className="text-xs text-muted-foreground">Не выбрано</SelectItem>
                    {cols.map((col) => <SelectItem key={col} value={col} className="text-xs"><span className="font-medium">{col}</span></SelectItem>)}
                  </SelectContent>
                </Select>
                {selectedArticleCol2 && selectedArticleCol2 !== NONE_VALUE && samplePreview(selectedArticleCol2)}
              </div>
            </div>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="min-h-screen bg-background text-foreground pb-12">
      {/* Header */}
      <header className="bg-card border-b border-border py-6 px-8 sticky top-0 z-10 shadow-sm">
        <div className="max-w-6xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-primary rounded-lg text-primary-foreground shadow-sm">
              <FileSpreadsheet className="w-6 h-6" />
            </div>
            <div>
              <h1 className="text-xl font-semibold tracking-tight">AI Умный Поиск Цен</h1>
              <p className="text-sm text-muted-foreground font-medium">Система закупок</p>
            </div>
          </div>
          {result && (
            <Button variant="outline" onClick={resetState} size="sm">Новый поиск</Button>
          )}
        </div>
      </header>

      <main className="max-w-7xl mx-auto mt-8 px-6">
        {/* Upload panel */}
        {!result && (
          <div className="grid gap-8 grid-cols-1 md:grid-cols-[1fr_300px]">
            <div className="space-y-6">
              <div className="space-y-2">
                <h2 className="text-2xl font-semibold tracking-tight">Анализ файлов</h2>
                <p className="text-muted-foreground">Загрузите прайс-лист поставщика и ваш список товаров для автоматического сопоставления.</p>
              </div>

              {pendingCachedResult && (
                <div className="p-4 bg-amber-50 border border-amber-200 rounded-lg flex items-start gap-3">
                  <AlertCircle className="w-5 h-5 shrink-0 mt-0.5 text-amber-600" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-amber-800">Найден результат в кэше</p>
                    <p className="text-xs text-amber-700 mt-0.5">Эти файлы уже обрабатывались ранее. Использовать сохранённый результат или запустить новый анализ?</p>
                    <div className="flex gap-2 mt-3">
                      <Button size="sm" onClick={applyCachedResult} className="h-7 text-xs bg-amber-600 hover:bg-amber-700 text-white border-0">
                        Использовать кэш
                      </Button>
                      <Button size="sm" variant="outline" onClick={reprocessFiles} className="h-7 text-xs border-amber-300 text-amber-800 hover:bg-amber-100">
                        Обработать заново
                      </Button>
                    </div>
                  </div>
                </div>
              )}

              {error && (
                <div className="p-4 bg-destructive/10 border border-destructive/20 rounded-lg flex items-start gap-3 text-destructive">
                  <AlertCircle className="w-5 h-5 shrink-0 mt-0.5" />
                  <p className="text-sm font-medium">{error}</p>
                </div>
              )}

              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-0">
                  <Dropzone label="Прайс-лист 1" accept=".xlsx,.xls,.csv" file={priceFile} onFileSelect={handlePriceFileSelect} />
                  <ColumnSelector />
                  {!showPriceFile2 ? (
                    <button
                      type="button"
                      onClick={() => setShowPriceFile2(true)}
                      className="mt-3 w-full text-xs text-primary border border-dashed border-primary/40 rounded-lg py-2 hover:bg-primary/5 transition-colors font-medium"
                    >
                      + Добавить второй прайс-лист
                    </button>
                  ) : (
                    <div className="mt-3 space-y-0">
                      <div className="flex items-center justify-between mb-1.5 px-0.5">
                        <span className="text-xs font-medium text-orange-700">Прайс-лист 2</span>
                        <button
                          type="button"
                          onClick={() => { setShowPriceFile2(false); handlePriceFile2Select(null); }}
                          className="text-xs text-muted-foreground hover:text-foreground"
                        >
                          Убрать
                        </button>
                      </div>
                      <Dropzone label="Прайс-лист 2" accept=".xlsx,.xls,.csv" file={priceFile2} onFileSelect={handlePriceFile2Select} />
                      <ColumnSelector2 />
                    </div>
                  )}
                </div>
                <div className="space-y-0">
                  <Dropzone label="Список товаров" accept=".xlsx,.xls,.csv" file={orderFile} onFileSelect={handleOrderFileSelect} />
                  <OrderColumnSelector />
                </div>
              </div>

              {isProcessing && (
                <div className="p-5 bg-muted/40 border border-border rounded-xl space-y-4">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2.5 min-w-0">
                      <Loader2 className="h-4 w-4 animate-spin text-primary shrink-0" />
                      <p className="text-sm font-medium truncate">{progress?.message ?? "Обработка файлов..."}</p>
                    </div>
                    <span className="text-3xl font-bold tabular-nums text-primary shrink-0">
                      {progressPercent !== null ? `${progressPercent}%` : "—"}
                    </span>
                  </div>

                  <div className="relative h-4 w-full overflow-hidden rounded-full bg-muted">
                    {progressPercent === null || (progress?.batchIndex === 0 && progressPercent === 0) ? (
                      <div className="absolute inset-0 rounded-full bg-primary/20">
                        <div className="h-full w-1/3 rounded-full bg-primary/60 animate-[progress-indeterminate_1.4s_ease-in-out_infinite]" />
                      </div>
                    ) : (
                      <div
                        className="h-full rounded-full bg-primary transition-all duration-500 ease-out"
                        style={{ width: `${progressPercent}%` }}
                      />
                    )}
                  </div>

                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <span>
                      {progress && progress.batchIndex > 0
                        ? `Батч ${progress.batchIndex} из ${progress.totalBatches}`
                        : "Подготовка..."}
                    </span>
                    <span>
                      {progress && progress.total > 0
                        ? `${progress.processed} из ${progress.total} позиций`
                        : ""}
                    </span>
                  </div>
                </div>
              )}

              <div className="flex justify-end pt-4 border-t border-border">
                <Button size="lg" onClick={handleProcess} disabled={!priceFile || !orderFile || isProcessing || isPreviewLoading} className="w-full sm:w-auto font-medium">
                  {isProcessing ? <><Loader2 className="mr-2 h-5 w-5 animate-spin" />ИИ анализирует файлы...</> : "Начать сопоставление"}
                </Button>
              </div>
            </div>

            <div>
              <Card className="bg-card border-border shadow-sm">
                <CardHeader className="pb-4 border-b border-border">
                  <CardTitle className="text-base font-semibold">Как это работает</CardTitle>
                </CardHeader>
                <CardContent className="pt-4 space-y-2 text-sm text-muted-foreground">
                  <p>1. ИИ читает оба файла и понимает их структуру.</p>
                  <p>2. Выберите нужные колонки прайса, если авто-определение не точное.</p>
                  <p>3. Товары сопоставляются по смыслу, артикулу и кодам.</p>
                  <p>4. Для незнайденных позиций можно указать артикул или цену вручную.</p>
                  <p>5. Скачайте итоговую таблицу в Excel.</p>
                </CardContent>
              </Card>
            </div>
          </div>
        )}

        {/* Results */}
        {result && (
          <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
            <div className="flex items-center justify-between flex-wrap gap-3">
              <div>
                <div className="flex items-center gap-3 flex-wrap">
                  <h2 className="text-2xl font-semibold tracking-tight">Результаты сопоставления</h2>
                  {fromCache && <Badge variant="outline" className="bg-blue-50 text-blue-700 border-blue-200 font-medium">Из кеша</Badge>}
                  {overrides.size > 0 && <Badge variant="outline" className="bg-violet-50 text-violet-700 border-violet-200 font-medium">{overrides.size} скорр.</Badge>}
                </div>
                {result.notes && <p className="text-sm text-muted-foreground mt-1">{result.notes}</p>}
                {!sessionId && <p className="text-xs text-amber-600 mt-1">Поиск по артикулу недоступен (данные сессии устарели)</p>}
              </div>
              <Button onClick={handleDownload} disabled={downloadPending}>
                {downloadPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Download className="mr-2 h-4 w-4" />}
                Скачать Excel
              </Button>
            </div>

            <Card className="border-border shadow-sm overflow-hidden">
              <div className="overflow-x-auto">
                <Table style={{ tableLayout: "fixed", width: colWidths.reduce((a, b) => a + b, 0) }}>
                  <colgroup>
                    {colWidths.map((w, i) => <col key={i} style={{ width: w }} />)}
                  </colgroup>
                  <TableHeader className="bg-muted/50">
                    <TableRow>
                      {([
                        { label: "Наименование", align: "left" },
                        { label: "Арт. / Код", align: "left" },
                        { label: "Совпадение в прайсе", align: "left" },
                        { label: "Арт. прайса", align: "left" },
                        { label: "Кол-во", align: "right" },
                        { label: "Ед.", align: "left" },
                        { label: "Цена за ед.", align: "right" },
                        { label: "Сумма", align: "right" },
                        { label: "Статус", align: "center" },
                      ] as const).map(({ label, align }, i) => (
                        <TableHead
                          key={i}
                          className={`font-medium text-muted-foreground select-none overflow-hidden relative ${align === "right" ? "text-right" : align === "center" ? "text-center" : ""}`}
                          style={{ width: colWidths[i] }}
                        >
                          <span className="truncate block">{label}</span>
                          <div
                            className="absolute right-0 top-0 h-full w-[5px] cursor-col-resize hover:bg-primary/40 active:bg-primary/60 transition-colors z-10"
                            onMouseDown={(e) => onResizeStart(i, e)}
                          />
                        </TableHead>
                      ))}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {result.items.map((item, idx) => {
                      const ov = overrides.get(idx);
                      const effectiveItem = ov ? { ...item, ...ov, totalPrice: ov.unitPrice != null ? ov.unitPrice * item.quantity : null } : item;
                      const isNotFound = !effectiveItem.found;
                      const artInput = articleInputs.get(idx) ?? "";
                      const candidates = searchResults.get(idx) ?? [];
                      const isSearching = searchLoading.get(idx) ?? false;
                      const priceEditing = editingPrice.get(idx);

                      const displayCode = item.article || (item.extractedCodes?.length ? item.extractedCodes.join(", ") : null);

                      const rowBg = !effectiveItem.found
                        ? "bg-amber-50/60 dark:bg-amber-950/20"
                        : ov
                        ? "bg-violet-50/30 dark:bg-violet-950/10"
                        : (item.matchMethod === "article" || item.matchMethod === "embedded_code")
                        ? "bg-emerald-50/30 dark:bg-emerald-950/10"
                        : "";

                      return (
                        <TableRow key={idx} className={rowBg}>
                          <TableCell className="py-2 overflow-hidden">
                            <div className="truncate font-medium text-sm" title={item.name}>{item.name}</div>
                          </TableCell>

                          <TableCell className="py-2">
                            {isNotFound ? (
                              <div className="relative">
                                <Input
                                  value={artInput}
                                  onChange={(e) => handleArticleInput(idx, e.target.value)}
                                  placeholder="Введите арт…"
                                  className="h-7 text-xs font-mono px-2 w-full"
                                />
                                {isSearching && <Loader2 className="absolute right-2 top-1.5 h-3 w-3 animate-spin text-muted-foreground" />}
                                {candidates.length > 0 && artInput.length > 0 && (
                                  <div className="absolute z-50 top-full mt-1 left-0 w-72 bg-popover border border-border rounded-md shadow-lg overflow-hidden">
                                    {candidates.map((c, ci) => (
                                      <button
                                        key={ci}
                                        onClick={() => applyCandidate(idx, c)}
                                        className="w-full text-left px-3 py-2 hover:bg-muted text-xs border-b border-border/50 last:border-0"
                                      >
                                        <div className="font-medium text-foreground truncate">{c.name}</div>
                                        <div className="flex gap-2 mt-0.5 text-muted-foreground">
                                          {c.article && <span className="font-mono">{c.article}</span>}
                                          <span className="font-semibold text-foreground">{c.price.toLocaleString("ru-RU")}</span>
                                          {c.unit && <span>{c.unit}</span>}
                                        </div>
                                      </button>
                                    ))}
                                  </div>
                                )}
                              </div>
                            ) : (
                              <span className="text-muted-foreground text-xs font-mono">{displayCode || "-"}</span>
                            )}
                          </TableCell>

                          <TableCell className="text-muted-foreground text-sm py-2">
                            {effectiveItem.found && effectiveItem.matchedName ? (
                              <div className="flex flex-col gap-1">
                                <div className="font-medium text-foreground">{effectiveItem.matchedName}</div>
                                {effectiveItem.alternatives && effectiveItem.alternatives.length > 0 && (
                                  <div className="flex flex-col gap-0.5">
                                    <span className="text-[10px] text-muted-foreground uppercase tracking-wider">Варианты:</span>
                                    {effectiveItem.alternatives.map((alt, ai) => (
                                      <div key={ai} className="text-xs text-muted-foreground flex gap-1">
                                        <span className="truncate max-w-[240px]" title={alt.name}>{alt.name}</span>
                                        {alt.article && <span className="font-mono text-[10px]">{alt.article}</span>}
                                        <span className="font-semibold">{alt.price.toLocaleString("ru-RU")}</span>
                                        {alt.unit && <span>{alt.unit}</span>}
                                      </div>
                                    ))}
                                  </div>
                                )}
                              </div>
                            ) : (
                              <span className="text-muted-foreground">-</span>
                            )}
                          </TableCell>

                          <TableCell className="text-muted-foreground text-xs font-mono py-2">
                            {effectiveItem.matchedArticle || "-"}
                          </TableCell>

                          <TableCell className="text-right py-2">{item.quantity}</TableCell>
                          <TableCell className="py-2">{item.unit || "-"}</TableCell>

                          <TableCell className="text-right py-2">
                            {priceEditing !== undefined || isNotFound ? (
                              <div className="flex items-center gap-1 justify-end">
                                <Input
                                  value={priceEditing ?? (effectiveItem.unitPrice != null ? String(effectiveItem.unitPrice) : "")}
                                  onChange={(e) => setEditingPrice((m) => { const n = new Map(m); n.set(idx, e.target.value); return n; })}
                                  onKeyDown={(e) => {
                                    if (e.key === "Enter") { applyManualPrice(idx, (e.target as HTMLInputElement).value); setEditingPrice((m) => { const n = new Map(m); n.delete(idx); return n; }); }
                                    if (e.key === "Escape") { setEditingPrice((m) => { const n = new Map(m); n.delete(idx); return n; }); }
                                  }}
                                  placeholder="Цена"
                                  className="h-7 text-xs text-right w-24 px-2"
                                />
                                {priceEditing !== undefined && (
                                  <>
                                    <button onClick={() => { applyManualPrice(idx, priceEditing); setEditingPrice((m) => { const n = new Map(m); n.delete(idx); return n; }); }} className="text-emerald-600 hover:text-emerald-700"><Check className="h-3.5 w-3.5" /></button>
                                    <button onClick={() => setEditingPrice((m) => { const n = new Map(m); n.delete(idx); return n; })} className="text-muted-foreground hover:text-foreground"><X className="h-3.5 w-3.5" /></button>
                                  </>
                                )}
                              </div>
                            ) : (
                              <div className="flex items-center gap-1 justify-end group cursor-pointer" onClick={() => setEditingPrice((m) => { const n = new Map(m); n.set(idx, effectiveItem.unitPrice != null ? String(effectiveItem.unitPrice) : ""); return n; })}>
                                <span className="font-medium">{effectiveItem.unitPrice != null ? effectiveItem.unitPrice.toLocaleString("ru-RU") : "-"}</span>
                                <Pencil className="h-3 w-3 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
                              </div>
                            )}
                          </TableCell>

                          <TableCell className="text-right font-semibold py-2">
                            {effectiveItem.totalPrice != null ? effectiveItem.totalPrice.toLocaleString("ru-RU") : "-"}
                          </TableCell>

                          <TableCell className="text-center py-2">
                            <div className="flex flex-col items-center gap-1">
                              <div className="flex items-center gap-1">
                                {methodBadge(item, ov)}
                                {ov && (
                                  <button onClick={() => clearOverride(idx)} className="text-muted-foreground hover:text-foreground ml-1" title="Сбросить">
                                    <X className="h-3 w-3" />
                                  </button>
                                )}
                              </div>
                              {effectiveItem.priceSource != null && (
                                <Badge
                                  variant="outline"
                                  className={`text-[10px] font-medium px-1.5 py-0 h-4 ${effectiveItem.priceSource === 1 ? "bg-blue-50 text-blue-600 border-blue-200" : "bg-orange-50 text-orange-600 border-orange-200"}`}
                                >
                                  П{effectiveItem.priceSource}
                                </Badge>
                              )}
                            </div>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            </Card>

            <div className="flex justify-end items-center py-4 px-6 bg-card border border-border rounded-lg shadow-sm">
              <div className="flex items-center gap-4">
                <span className="text-muted-foreground font-medium text-sm">Итого:</span>
                <span className="text-2xl font-bold tracking-tight">
                  {effectiveGrandTotal.toLocaleString("ru-RU")}{" "}
                  <span className="text-muted-foreground text-lg ml-1 font-medium">{result.currency}</span>
                </span>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
