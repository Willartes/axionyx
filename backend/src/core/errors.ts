export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message)
  }
}

export const badRequest = (msg: string, details?: unknown) => new HttpError(400, 'requisicao_invalida', msg, details)
export const unauthorized = (msg = 'Sessão inválida ou expirada. Faça login novamente.') => new HttpError(401, 'nao_autenticado', msg)
export const forbidden = (msg = 'Você não tem permissão para esta operação.') => new HttpError(403, 'sem_permissao', msg)
export const notFound = (what = 'Registro') => new HttpError(404, 'nao_encontrado', `${what} não encontrado(a).`)
export const conflict = (msg: string, details?: unknown) => new HttpError(409, 'conflito', msg, details)
export const unprocessable = (msg: string, details?: unknown) => new HttpError(422, 'validacao', msg, details)

/** Converte erros do PostgreSQL em mensagens compreensíveis. */
export function fromPg(e: any): HttpError | null {
  if (!e || typeof e.code !== 'string') return null
  switch (e.code) {
    case '23505': {
      const c = String(e.constraint || '')
      const map: Record<string, string> = {
        users_email_uq: 'Já existe um usuário com este e-mail.',
        customers_doc_uq: 'Já existe um cliente com este CPF/CNPJ.',
        variants_barcode_uq: 'Código de barras já utilizado por outra variação.',
        product_variants_company_id_sku_key: 'SKU já utilizado por outra variação.',
        products_company_id_code_key: 'Já existe um produto com esta referência.',
        purchase_entries_key_uq: 'Esta NF-e já foi importada para esta empresa.',
        suppliers_cnpj_uq: 'Já existe um fornecedor com este CNPJ.',
        cash_session_open_uq: 'Já existe um caixa aberto para este terminal.',
      }
      return conflict(map[c] || 'Registro duplicado: já existe um item com estes dados.', { constraint: c })
    }
    case '23503': return conflict('Operação viola uma referência entre registros (item relacionado inexistente ou em uso).')
    case '23514': return unprocessable('Os dados violam uma regra de integridade.', { constraint: e.constraint })
    case '22P02': return badRequest('Formato de identificador ou valor inválido.')
    case '40001': case '40P01': return conflict('Operação concorrente detectada. Tente novamente.')
    default: return null
  }
}
