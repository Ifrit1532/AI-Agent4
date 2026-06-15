import React, { useCallback } from "react";
import { cn } from "@/lib/utils";
import { UploadCloud, FileType } from "lucide-react";

interface DropzoneProps {
  label: string;
  accept: string;
  file: File | null;
  onFileSelect: (file: File) => void;
  className?: string;
}

export function Dropzone({ label, accept, file, onFileSelect, className }: DropzoneProps) {
  const [isDragging, setIsDragging] = React.useState(false);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragging(false);

      if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        onFileSelect(e.dataTransfer.files[0]);
      }
    },
    [onFileSelect]
  );

  const handleFileInput = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (e.target.files && e.target.files.length > 0) {
        onFileSelect(e.target.files[0]);
      }
    },
    [onFileSelect]
  );

  return (
    <div
      className={cn(
        "relative rounded-xl border-2 border-dashed transition-all duration-200 p-8 flex flex-col items-center justify-center text-center group cursor-pointer",
        isDragging
          ? "border-primary bg-primary/5"
          : "border-border bg-card hover:border-primary/50 hover:bg-muted/50",
        file ? "border-solid border-primary/20 bg-primary/5" : "",
        className
      )}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <input
        type="file"
        accept={accept}
        onChange={handleFileInput}
        className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
        data-testid={`input-file-${label}`}
      />
      
      {file ? (
        <div className="flex flex-col items-center space-y-2">
          <div className="p-3 bg-primary/10 rounded-full text-primary">
            <FileType className="w-6 h-6" />
          </div>
          <div className="space-y-1">
            <p className="text-sm font-medium text-foreground">{file.name}</p>
            <p className="text-xs text-muted-foreground">
              {(file.size / 1024 / 1024).toFixed(2)} MB
            </p>
          </div>
        </div>
      ) : (
        <div className="flex flex-col items-center space-y-4">
          <div className="p-3 bg-muted rounded-full text-muted-foreground group-hover:text-primary transition-colors">
            <UploadCloud className="w-6 h-6" />
          </div>
          <div className="space-y-1">
            <p className="text-sm font-medium text-foreground">{label}</p>
            <p className="text-xs text-muted-foreground">
              Перетащите файл или нажмите для выбора
            </p>
            <p className="text-xs text-muted-foreground/60 mt-2">
              Поддерживаемые форматы: .xlsx, .xls, .csv
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
