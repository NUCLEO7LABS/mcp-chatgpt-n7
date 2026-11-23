// O que muda de um sistema para outro: onde fica a pasta de imagens da pessoa.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Pasta de imagens da pessoa:
// - Windows e Mac: ~/Pictures (no Windows em português ela aparece como "Imagens", mas o caminho é Pictures).
// - Linux: a que o sistema define (XDG_PICTURES_DIR em ~/.config/user-dirs.dirs; em português, ~/Imagens).
export function pastaDeImagens(): string {
  const casa = homedir();
  if (process.platform !== "linux") return join(casa, "Pictures");
  try {
    const config = join(process.env.XDG_CONFIG_HOME ?? join(casa, ".config"), "user-dirs.dirs");
    const m = readFileSync(config, "utf8").match(/^XDG_PICTURES_DIR="?([^"\n]+)"?/m);
    if (m) {
      const pasta = m[1].replace(/^\$HOME/, casa);
      if (pasta !== casa) return pasta;
    }
  } catch {
    // sem user-dirs.dirs: tenta os nomes de costume
  }
  for (const nome of ["Imagens", "Pictures"]) if (existsSync(join(casa, nome))) return join(casa, nome);
  return join(casa, "Pictures");
}
