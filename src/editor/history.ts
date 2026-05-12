export class EditorHistory {
  private readonly entries: string[] = [];

  push(value: string) {
    const next = value.trim();

    if (!next) {
      return;
    }

    this.entries.push(next);
  }

  list() {
    return [...this.entries];
  }
}

