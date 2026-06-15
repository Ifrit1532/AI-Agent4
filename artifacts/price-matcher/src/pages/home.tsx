import { useState } from "react";
import { Dropzone } from "@/components/ui/dropzone";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Loader2, Download, AlertCircle, FileSpreadsheet } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useDownloadMatchResult } from "@workspace/api-client-react";
import type { MatchResult } from "@workspace/api-client-react";

interface ProgressState {
  processed: number;
  total: number;
  batchIndex: number;
  totalBatches: number;
  message: string;
}

function parseSSELine(line: string): { event: string; data: unknown } | null {
  if (!line.trim() || line.startsWith(":")) return null;
  return null;
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
        try {
          yield { event: currentEvent, data: JSON.parse(raw) };
        } catch {
          // skip malformed
        }
        currentEvent = "message";
      }
    }
  }

  // suppress unused warning
  void parseSSELine;
}

export default function Home() {
  const { toast } = useToast();
  const [priceFile, setPriceFile] = useState<File | null>(null);
  const [orderFile, setOrderFile] = useState<File | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState<ProgressState | null>(null);
  const [result, setResult] = useState<MatchResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const downloadMutation = useDownloadMatchResult();

  const handleProcess = async () => {
    if (!priceFile || !orderFile) {
      toast({
        title: "Ошибка",
        description: "Пожалуйста, загрузите оба файла",
        variant: "destructive",
      });
      return;
    }

    setIsProcessing(true);
    setError(null);
    setResult(null);
    setProgress(null);

    try {
      const formData = new FormData();
      formData.append("priceFile", priceFile);
      formData.append("orderFile", orderFile);

      const res = await fetch("/api/match", {
        method: "POST",
        body: formData,
      });

      if (!res.ok || !res.body) {
        const errorData = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(errorData.error || "Произошла ошибка при обработке файлов");
      }

      for await (const { event, data } of readSSEEvents(res)) {
        const d = data as Record<string, unknown>;

        if (event === "status") {
          setProgress({
            processed: 0,
            total: (d.orderCount as number) || 0,
            batchIndex: 0,
            totalBatches: 0,
            message: (d.message as string) || "Обработка...",
          });
        } else if (event === "progress") {
          setProgress({
            processed: (d.processed as number) || 0,
            total: (d.total as number) || 0,
            batchIndex: (d.batchIndex as number) || 0,
            totalBatches: (d.totalBatches as number) || 0,
            message: `Батч ${d.batchIndex as number} из ${d.totalBatches as number}...`,
          });
        } else if (event === "result") {
          setResult(data as MatchResult);
          setProgress(null);
          toast({
            title: "Готово",
            description: "Файлы успешно проанализированы",
          });
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

  const handleDownload = async () => {
    if (!result) return;
    try {
      const { downloadId } = await downloadMutation.mutateAsync({ data: result });
      window.location.href = `/api/match/download/${downloadId}`;
    } catch (err) {
      console.error("Download error:", err);
      toast({
        title: "Ошибка скачивания",
        description: "Не удалось скачать результат",
        variant: "destructive",
      });
    }
  };

  const resetState = () => {
    setPriceFile(null);
    setOrderFile(null);
    setResult(null);
    setError(null);
    setProgress(null);
  };

  const progressPercent =
    progress && progress.total > 0
      ? Math.round((progress.processed / progress.total) * 100)
      : null;

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
            <Button variant="outline" onClick={resetState} size="sm" data-testid="button-new-match">
              Новый поиск
            </Button>
          )}
        </div>
      </header>

      <main className="max-w-6xl mx-auto mt-8 px-8">
        {!result && (
          <div className="grid gap-8 grid-cols-1 md:grid-cols-[1fr_300px]">
            {/* Upload Area */}
            <div className="space-y-6">
              <div className="space-y-2">
                <h2 className="text-2xl font-semibold tracking-tight">Анализ файлов</h2>
                <p className="text-muted-foreground">
                  Загрузите прайс-лист поставщика и ваш список товаров для автоматического сопоставления.
                </p>
              </div>

              {error && (
                <div className="p-4 bg-destructive/10 border border-destructive/20 rounded-lg flex items-start gap-3 text-destructive">
                  <AlertCircle className="w-5 h-5 shrink-0 mt-0.5" />
                  <p className="text-sm font-medium">{error}</p>
                </div>
              )}

              <div className="grid gap-4 md:grid-cols-2">
                <Dropzone
                  label="Прайс-лист"
                  accept=".xlsx,.xls,.csv"
                  file={priceFile}
                  onFileSelect={setPriceFile}
                />
                <Dropzone
                  label="Список товаров"
                  accept=".xlsx,.xls,.csv"
                  file={orderFile}
                  onFileSelect={setOrderFile}
                />
              </div>

              {/* Progress bar */}
              {isProcessing && (
                <div className="space-y-3 p-4 bg-muted/40 border border-border rounded-lg">
                  <div className="flex items-center gap-3">
                    <Loader2 className="h-4 w-4 animate-spin text-primary shrink-0" />
                    <p className="text-sm font-medium text-foreground">
                      {progress?.message ?? "Обработка файлов..."}
                    </p>
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
                <Button
                  size="lg"
                  onClick={handleProcess}
                  disabled={!priceFile || !orderFile || isProcessing}
                  className="w-full sm:w-auto font-medium"
                  data-testid="button-process"
                >
                  {isProcessing ? (
                    <>
                      <Loader2 className="mr-2 h-5 w-5 animate-spin" />
                      ИИ анализирует файлы...
                    </>
                  ) : (
                    "Начать сопоставление"
                  )}
                </Button>
              </div>
            </div>

            {/* Info panel */}
            <div className="space-y-6">
              <Card className="bg-card border-border shadow-sm">
                <CardHeader className="pb-4 border-b border-border">
                  <CardTitle className="text-base font-semibold">Как это работает</CardTitle>
                </CardHeader>
                <CardContent className="pt-4 space-y-4">
                  <div className="space-y-2 text-sm text-muted-foreground">
                    <p>1. ИИ читает оба файла и понимает их структуру.</p>
                    <p>2. Товары сопоставляются по смыслу, а не только по точному совпадению названий.</p>
                    <p>3. Вы получаете итоговую таблицу с ценами, которую можно скачать в Excel.</p>
                  </div>
                </CardContent>
              </Card>
            </div>
          </div>
        )}

        {/* Results Area */}
        {result && (
          <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-2xl font-semibold tracking-tight">Результаты сопоставления</h2>
                {result.notes && (
                  <p className="text-sm text-muted-foreground mt-1">{result.notes}</p>
                )}
              </div>
              <Button
                onClick={handleDownload}
                disabled={downloadMutation.isPending}
                data-testid="button-download"
              >
                {downloadMutation.isPending ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Download className="mr-2 h-4 w-4" />
                )}
                Скачать Excel
              </Button>
            </div>

            <Card className="border-border shadow-sm overflow-hidden">
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader className="bg-muted/50">
                    <TableRow>
                      <TableHead className="w-[300px] font-medium text-muted-foreground">Наименование</TableHead>
                      <TableHead className="font-medium text-muted-foreground">Совпадение в прайсе</TableHead>
                      <TableHead className="text-right font-medium text-muted-foreground w-[100px]">Кол-во</TableHead>
                      <TableHead className="font-medium text-muted-foreground w-[80px]">Ед.</TableHead>
                      <TableHead className="text-right font-medium text-muted-foreground w-[120px]">Цена за ед.</TableHead>
                      <TableHead className="text-right font-medium text-muted-foreground w-[120px]">Сумма</TableHead>
                      <TableHead className="text-center font-medium text-muted-foreground w-[100px]">Статус</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {result.items.map((item, idx) => (
                      <TableRow
                        key={idx}
                        className={!item.found ? "bg-amber-50/50 dark:bg-amber-950/20" : ""}
                      >
                        <TableCell className="font-medium">{item.name}</TableCell>
                        <TableCell className="text-muted-foreground text-sm">
                          {item.matchedName || "-"}
                        </TableCell>
                        <TableCell className="text-right">{item.quantity}</TableCell>
                        <TableCell>{item.unit || "-"}</TableCell>
                        <TableCell className="text-right font-medium">
                          {item.unitPrice != null
                            ? item.unitPrice.toLocaleString("ru-RU")
                            : "-"}
                        </TableCell>
                        <TableCell className="text-right font-semibold">
                          {item.totalPrice != null
                            ? item.totalPrice.toLocaleString("ru-RU")
                            : "-"}
                        </TableCell>
                        <TableCell className="text-center">
                          {item.found ? (
                            <Badge
                              variant="outline"
                              className="bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/30 dark:text-emerald-400 dark:border-emerald-800 font-medium"
                            >
                              Найден
                            </Badge>
                          ) : (
                            <Badge
                              variant="outline"
                              className="bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/30 dark:text-amber-400 dark:border-amber-800 font-medium"
                            >
                              Не найден
                            </Badge>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </Card>

            <div className="flex justify-end items-center py-4 px-6 bg-card border border-border rounded-lg shadow-sm">
              <div className="flex items-center gap-4">
                <span className="text-muted-foreground font-medium text-sm">Итого:</span>
                <span className="text-2xl font-bold tracking-tight">
                  {result.grandTotal.toLocaleString("ru-RU")}{" "}
                  <span className="text-muted-foreground text-lg ml-1 font-medium">
                    {result.currency}
                  </span>
                </span>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
