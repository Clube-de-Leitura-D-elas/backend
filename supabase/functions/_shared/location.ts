/**
 * Bairro do local do encontro.
 *
 * `locations` não tem coluna de bairro: o endereço chega da API do Google
 * Places no formato "<logradouro>, <número> - <bairro>, <cidade> - <UF>".
 * Pegamos o trecho logo depois do primeiro " - ", até a vírgula. Endereço em
 * outro formato devolve null, e a tela mostra o placeholder de "não informado".
 */
export function readNeighborhood(
  address: string | null | undefined,
): string | null {
  if (!address) return null;

  const parts = address.split(" - ");
  if (parts.length < 2) return null;

  const neighborhood = parts[1].split(",")[0].trim();
  return neighborhood ? neighborhood : null;
}
