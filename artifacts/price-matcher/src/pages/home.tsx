import { useState, useRef, useCallback } from "react";
import { Dropzone } from "@/components/ui/dropzone";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Input } from "@/components/ui/input";
import { Loader2, Download, AlertCircle, FileSpreadsheet, Pencil, Check, X } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useDownloadMatchResult } from "@workspace/api-client-react";
import type { MatchResult } from "@workspace/api-client-react";

// Extended types not yet in generated client
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

  // Per-row overrides: index → override
  const [overrides, setOverrides] = useState<Map<number, Override>>(new Map());
  // Per-row article search state
  const [articleInputs, setArticleInputs] = useState<Map<number, string>>(new Map());
  const [searchResults, setSearchResults] = useState<Map<number, PriceCandidate[]>>(new Map());
  const [searchLoading, setSearchLoading] = useState<Map<number, boolean>>(new Map());
  const [editingPrice, setEditingPrice] = useState<Map<number, string>>(new Map());

  const downloadMutation = useDownloadMatchResult();

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
        } else if (event === "cached") {
          setProgress(null);
          setFromCache(true);
          toast({ title: "Из кеша", description: "Результат загружен мгновенно из кеша" });
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
      console.error("Upload error:", err);
      setError(err instanceof Error ? err.message : "Произошла ошибка");
      setProgress(null);
    } finally {
      setIsProcessing(false);
    }
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
  const handleDownload = async () => {
    if (!result) return;
    try {
      const payload = { ...result, items: effectiveItems, grandTotal: effectiveGrandTotal };
      const { downloadId } = await downloadMutation.mutateAsync({ data: payload as unknown as MatchResult });
      window.location.href = `/api/match/download/${downloadId}`;
    } catch {
      toast({ title: "Ошибка скачивания", description: "Не удалось скачать результат", variant: "destructive" });
    }
  };

  const resetState = () => {
    setPriceFile(null); setOrderFile(null); setResult(null); setError(null);
    setProgress(null); setFromCache(false); setSessionId(null);
    setOverrides(new Map()); setArticleInputs(new Map());
    setSearchResults(new Map()); setSearchLoading(new Map()); setEditingPrice(new Map());
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

              {error && (
                <div className="p-4 bg-destructive/10 border border-destructive/20 rounded-lg flex items-start gap-3 text-destructive">
                  <AlertCircle className="w-5 h-5 shrink-0 mt-0.5" />
                  <p className="text-sm font-medium">{error}</p>
                </div>
              )}

              <div className="grid gap-4 md:grid-cols-2">
                <Dropzone label="Прайс-лист" accept=".xlsx,.xls,.csv" file={priceFile} onFileSelect={setPriceFile} />
                <Dropzone label="Список товаров" accept=".xlsx,.xls,.csv" file={orderFile} onFileSelect={setOrderFile} />
              </div>

              {isProcessing && (
                <div className="space-y-3 p-4 bg-muted/40 border border-border rounded-lg">
                  <div className="flex items-center gap-3">
                    <Loader2 className="h-4 w-4 animate-spin text-primary shrink-0" />
                    <p className="text-sm font-medium">{progress?.message ?? "Обработка файлов..."}</p>
                  </div>
                  {progressPercent !== null && (
                    <>
                      <Progress value={progressPercent} className="h-2" />
                      <p className="text-xs text-muted-foreground text-right">
                        {progress!.processed} из {progress!.total} позиций — {progressPercent}%
                      </p>
                    </>
                  )}
                </div>
              )}

              <div className="flex justify-end pt-4 border-t border-border">
                <Button size="lg" onClick={handleProcess} disabled={!priceFile || !orderFile || isProcessing} className="w-full sm:w-auto font-medium">
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
                  <p>2. Товары сопоставляются по смыслу, артикулу и кодам.</p>
                  <p>3. Для незнайденных позиций можно указать артикул или цену вручную.</p>
                  <p>4. Скачайте итоговую таблицу в Excel.</p>
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
              <Button onClick={handleDownload} disabled={downloadMutation.isPending}>
                {downloadMutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Download className="mr-2 h-4 w-4" />}
                Скачать Excel
              </Button>
            </div>

            <Card className="border-border shadow-sm overflow-hidden">
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader className="bg-muted/50">
                    <TableRow>
                      <TableHead className="w-[220px] font-medium text-muted-foreground">Наименование</TableHead>
                      <TableHead className="w-[130px] font-medium text-muted-foreground">Арт. / Код</TableHead>
                      <TableHead className="font-medium text-muted-foreground">Совпадение в прайсе</TableHead>
                      <TableHead className="w-[110px] font-medium text-muted-foreground">Арт. прайса</TableHead>
                      <TableHead className="text-right font-medium text-muted-foreground w-[65px]">Кол-во</TableHead>
                      <TableHead className="font-medium text-muted-foreground w-[55px]">Ед.</TableHead>
                      <TableHead className="text-right font-medium text-muted-foreground w-[120px]">Цена за ед.</TableHead>
                      <TableHead className="text-right font-medium text-muted-foreground w-[110px]">Сумма</TableHead>
                      <TableHead className="text-center font-medium text-muted-foreground w-[110px]">Статус</TableHead>
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
                          {/* Name */}
                          <TableCell className="font-medium text-sm py-2">{item.name}</TableCell>

                          {/* Article / Code — editable for not-found rows */}
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
                                {/* Dropdown */}
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

                          {/* Matched name */}
                          <TableCell className="text-muted-foreground text-sm py-2">
                            {effectiveItem.matchedName || "-"}
                          </TableCell>

                          {/* Matched article */}
                          <TableCell className="text-muted-foreground text-xs font-mono py-2">
                            {effectiveItem.matchedArticle || "-"}
                          </TableCell>

                          {/* Qty */}
                          <TableCell className="text-right py-2">{item.quantity}</TableCell>

                          {/* Unit */}
                          <TableCell className="py-2">{item.unit || "-"}</TableCell>

                          {/* Price — always editable */}
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

                          {/* Total */}
                          <TableCell className="text-right font-semibold py-2">
                            {effectiveItem.totalPrice != null ? effectiveItem.totalPrice.toLocaleString("ru-RU") : "-"}
                          </TableCell>

                          {/* Status + clear override */}
                          <TableCell className="text-center py-2">
                            <div className="flex items-center justify-center gap-1">
                              {methodBadge(item, ov)}
                              {ov && (
                                <button onClick={() => clearOverride(idx)} className="text-muted-foreground hover:text-foreground ml-1" title="Сбросить">
                                  <X className="h-3 w-3" />
                                </button>
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

            {/* Grand total */}
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
