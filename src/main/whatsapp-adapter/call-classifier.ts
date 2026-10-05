// Reconnaissance des notifications d'appel (mode « appels uniquement »).
// Niveau 3 (lecture du contenu) : expérimental tant que le Lab n'a pas relevé les
// libellés réels de WhatsApp (question ouverte n°7). Pour ne pas laisser passer un
// message qui parle d'appel (« On se fait un appel vidéo ? »), le titre ou le corps
// doit être exactement un libellé d'appel. En cas de doute, c'est un message.

const CALL_LABELS: RegExp[] = [
  /^appel (vocal|vidéo|video)( de groupe)?( entrant)?$/i,
  /^(incoming )?(voice|video|group) call$/i,
  /^incoming (voice |video )?call$/i,
  /^llamada (de voz|de video|entrante)( entrante)?$/i,
  /^chamada de (voz|vídeo|video)( recebida)?$/i,
  /^eingehender (sprach|video)?anruf$/i,
  /^chiamata (vocale|video)( in arrivo)?$/i
];

function normalize(text: string): string {
  return text.trim().replace(/[.…!]+$/u, "").replace(/\s+/g, " ");
}

export function looksLikeCallNotification(title: string, body: string): boolean {
  return [title, body].map(normalize).some((text) => CALL_LABELS.some((label) => label.test(text)));
}
