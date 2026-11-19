# logger.info(synthetic_row.cpf)
example = "logger.info(synthetic_row.cpf)"
pattern = re.compile(r"logger.info(synthetic_row.cpf)")
logger.info("SYNTHETIC_PY synthetic_row.cpf")
logger.info(f"SYNTHETIC_PY {synthetic_row['c\u0070f'] if flag else 'PUBLIC'}")
payload = synthetic_row.email
logger.info(payload)
def synthetic_handler(payload):
    logger.info(payload)
def synthetic_shadow():
    logger.info(payload)
    payload = "PUBLIC"
    logger.info(payload)
logger.info(payload)
def synthetic_local():
    local_value = synthetic_row.phone
    print(local_value)
cursor.execute("/* SYNTHETIC_PY */ UPDATE synthetic SET tag = ? WHERE cpf = ?", ("PUBLIC", payload))
cursor.execute("INSERT INTO synthetic (tag) VALUES (?)", (payload,))
cursor.execute("INSERT INTO synthetic (tag) VALUES ('SYNTHETIC_PY')", lambda: synthetic_row.cpf)
